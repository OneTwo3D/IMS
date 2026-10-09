import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test, { after, before, beforeEach, mock } from 'node:test'

import { Prisma } from '../app/generated/prisma/client'
import { unconditionalMoneySentences, unlicensedHistoryClaims } from './helpers/unconditional-instruction'
import { bundleCreateMaybeSentText } from '../lib/connectors/mintsoft/sync/bundle-create-outcome'
import { setOutboundRefusalSink } from '../lib/security/outbound-write-refusal-log'

/**
 * A MINTSOFT BUNDLE CREATE THAT MAY HAVE BEEN SENT IS NEVER SENT AGAIN WITHOUT LOOKING FIRST.
 *
 * `runBundleSyncForProduct` claims a product with a `pending:` sentinel row, sends `PUT /api/Product/Bundle`
 * and finalises the row. It used to DELETE the claim on every failure of that PUT, including a timeout, a
 * dropped connection or a 5xx, where Mintsoft may well have created the bundle: the next run then found no
 * claim and (while the bundle was not yet readable) sent the create again. A failure the installation's own
 * outbound-write hold produced is different: the request never left, and releasing the claim is right.
 *
 * Real connector and real transport against a LOCAL listener that plays Mintsoft. The database is an
 * in-memory double of exactly the delegates the sync touches. No vendor host is ever contacted.
 */

setOutboundRefusalSink(async () => undefined)

type LinkRow = { id: string; connector: string; productId: string; externalBundleId: string; checksum: string | null; lastSyncedAt: Date | null; updatedAt: Date; sku?: string }
const links = new Map<string, LinkRow>()
let linkSeq = 0
const discrepancies: Array<Record<string, unknown>> = []
const mutationEvents: Array<Record<string, unknown>> = []
const activities: Array<Record<string, unknown>> = []

const PRODUCT_ID = 'prod-kit-1'
const IMS_BUNDLE = { components: [{ sku: 'COMP-A', qty: 2, ext: '100' }] }

function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
}

type ClaimWhere = {
  externalBundleId: { startsWith: string }
  NOT?: { externalBundleId: { startsWith: string } }
  product?: { sku: { contains: string } }
}
function claimRows(where: ClaimWhere): LinkRow[] {
  return [...links.values()].filter((row) =>
    row.externalBundleId.startsWith(where.externalBundleId.startsWith)
    && !(where.NOT && row.externalBundleId.startsWith(where.NOT.externalBundleId.startsWith))
    && (!where.product || (row.sku ?? 'KIT-1').toLowerCase().includes(where.product.sku.contains.toLowerCase())))
}
let auditFails = false

const dbDouble: Record<string, any> = {
  externalWmsBinding: {
    findMany: async () => [{ warehouseId: 'wh-1', bundleSyncDirection: 'IMS_TO_WMS', warehouse: { code: 'W1' } }],
  },
  product: {
    findUnique: async () => {
      const link = [...links.values()].find((row) => row.productId === PRODUCT_ID)
      return {
        id: PRODUCT_ID,
        sku: 'KIT-1',
        name: 'Starter Kit',
        type: 'KIT',
        lifecycleStatus: 'ACTIVE',
        productComponents: IMS_BUNDLE.components.map((component) => ({
          qty: component.qty,
          component: { id: `c-${component.sku}`, sku: component.sku, wmsProductLinks: [{ externalProductId: component.ext }] },
        })),
        wmsProductLinks: [{ externalProductId: '500' }],
        wmsBundleLinks: link
          ? [{ id: link.id, externalBundleId: link.externalBundleId, checksum: link.checksum, lastSyncedAt: link.lastSyncedAt }]
          : [],
      }
    },
  },
  wmsBundleLink: {
    create: async ({ data }: { data: { connector: string; productId: string; externalBundleId: string; checksum: string | null } }) => {
      if ([...links.values()].some((row) => row.connector === data.connector && row.productId === data.productId)) throw uniqueViolation()
      linkSeq += 1
      const row: LinkRow = { id: `link-${linkSeq}`, ...data, lastSyncedAt: null, updatedAt: new Date() }
      links.set(row.id, row)
      return { id: row.id }
    },
    findUnique: async ({ where }: { where: { connector_productId?: { connector: string; productId: string }; id?: string } }) => {
      if (where.id) {
        const row = links.get(where.id)
        return row ? { ...row, product: { sku: 'KIT-1', id: PRODUCT_ID, name: 'Starter Kit' } } : null
      }
      return [...links.values()].find((row) => row.connector === where.connector_productId!.connector && row.productId === where.connector_productId!.productId) ?? null
    },
    findMany: async (args: { where: ClaimWhere; skip?: number; take?: number }) =>
      claimRows(args.where)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 1e9))
        .map((row) => ({ ...row, product: { sku: row.sku ?? 'KIT-1', id: row.productId, name: 'Starter Kit' } })),
    count: async (args: { where: ClaimWhere }) => claimRows(args.where).length,
    updateMany: async ({ where, data }: { where: { id: string; externalBundleId: string }; data: Partial<LinkRow> }) => {
      const row = links.get(where.id)
      if (!row || row.externalBundleId !== where.externalBundleId) return { count: 0 }
      Object.assign(row, data, { updatedAt: new Date() })
      return { count: 1 }
    },
    deleteMany: async ({ where }: { where: { id: string; externalBundleId: string | { startsWith: string }; updatedAt?: { lte: Date } } }) => {
      const row = links.get(where.id)
      if (row && where.updatedAt && row.updatedAt.getTime() > where.updatedAt.lte.getTime()) return { count: 0 }
      const match = row && (typeof where.externalBundleId === 'string'
        ? row.externalBundleId === where.externalBundleId
        : row.externalBundleId.startsWith(where.externalBundleId.startsWith))
      if (!row || !match) return { count: 0 }
      links.delete(where.id)
      return { count: 1 }
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<LinkRow> }) => {
      const row = links.get(where.id)
      if (!row) throw new Error('no such link')
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
    upsert: async ({ where, create, update }: { where: { connector_productId: { connector: string; productId: string } }; create: Partial<LinkRow>; update: Partial<LinkRow> }) => {
      const existing = [...links.values()].find((row) => row.connector === where.connector_productId.connector && row.productId === where.connector_productId.productId)
      if (existing) { Object.assign(existing, update, { updatedAt: new Date() }); return existing }
      linkSeq += 1
      const row = { id: `link-${linkSeq}`, lastSyncedAt: null, checksum: null, updatedAt: new Date(), ...create } as LinkRow
      links.set(row.id, row)
      return row
    },
  },
  wmsProductLink: { findFirst: async () => ({ externalProductId: '500' }) },
  wmsMutationEvent: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (auditFails) throw new Error('audit write failed')
      mutationEvents.push(data)
      return data
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = new Map([...links.entries()].map(([key, row]) => [key, { ...row }]))
    const eventsBefore = mutationEvents.length
    try {
      return await fn(dbDouble)
    } catch (error) {
      links.clear()
      for (const [key, row] of snapshot) links.set(key, row)
      mutationEvents.length = eventsBefore
      throw error
    }
  },
  wmsStockDiscrepancy: {
    updateMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: Record<string, unknown> }) => { discrepancies.push(data); return data },
  },
}

mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { activities.push(entry) },
    redactActivityLogText: (text: string) => text,
  },
})
mock.module('@/lib/domain/wms/mutation-audit', {
  namedExports: {
    recordWmsMutationEvent: async (event: Record<string, unknown>) => { mutationEvents.push(event) },
    buildWmsMutationEventRow: (event: Record<string, unknown>) => event,
  },
})

let baseUrl = ''
mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => ({
      baseUrl, authMode: 'credentials', staticApiKey: '', username: 'u', password: 'p', webhookSecret: '', clientId: '89', orderLookupConnector: null,
    }),
    getMintsoftAccessToken: async () => 'k',
    invalidateMintsoftAccessToken: async () => undefined,
  },
})

// ---------------------------------------------------------------------------------------------
// The local listener that plays Mintsoft.
// ---------------------------------------------------------------------------------------------

type PutMode = 'drop-unseen' | 'drop-after-registering' | 'drop-after-registering-different' | 'ok'
let putMode: PutMode = 'drop-unseen'
let lookupFails = false
let garbageLookup = false
let emptyLookup = false
let extraMalformedComponent = false
let registered: { id: string; components: Array<{ ProductId: number; SKU: string; Quantity: number }> } | null = null
const requestLog: string[] = []

const MATCHING = [{ ProductId: 100, SKU: 'COMP-A', Quantity: 2 }]
const DIFFERENT = [{ ProductId: 100, SKU: 'COMP-A', Quantity: 5 }]

function bundleBody(): string {
  const components: unknown[] = [...registered!.components]
  if (extraMalformedComponent) components.push({ ProductId: 777, SKU: '', Quantity: 'many' })
  return JSON.stringify({ ID: Number(registered!.id), SKU: 'KIT-1', Name: 'Starter Kit', Components: components })
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const line = `${req.method} ${(req.url ?? '').split('?')[0]}`
  requestLog.push(line)
  req.resume()
  req.on('end', () => {
    if (line === 'PUT /api/Product/Bundle') {
      if (putMode === 'drop-after-registering') registered = { id: '900', components: MATCHING }
      if (putMode === 'drop-after-registering-different') registered = { id: '900', components: DIFFERENT }
      if (putMode === 'ok') {
        registered = { id: '900', components: MATCHING }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ProductId: 900 }))
        return
      }
      req.socket.destroy() // the answer is lost: the caller cannot tell whether Mintsoft acted
      return
    }
    if (/^GET \/api\/Product\/(500|900)\/Bundle$/.test(line)) {
      // only the lookup AFTER the create fails
      if (lookupFails && requestLog.includes('PUT /api/Product/Bundle')) { res.writeHead(500); res.end(); return }
      if (garbageLookup) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"unexpected":true}'); return }
      if (emptyLookup && !registered) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return }
      if (!registered) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(bundleBody())
      return
    }
    res.writeHead(500); res.end()
  })
}

const server = createServer(handle)
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
})
after(async () => {
  delete process.env.MINTSOFT_WRITE_ALLOWED
  delete process.env.E2E_TEST_MODE
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  auditFails = false
  links.clear(); discrepancies.length = 0; mutationEvents.length = 0; activities.length = 0
  requestLog.length = 0
  registered = null
  lookupFails = false
  garbageLookup = false
  emptyLookup = false
  extraMalformedComponent = false
  putMode = 'drop-unseen'
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89`
})

const puts = () => requestLog.filter((line) => line === 'PUT /api/Product/Bundle').length
const lookups = () => requestLog.filter((line) => line === 'GET /api/Product/500/Bundle').length
const sentinelRows = () => [...links.values()].filter((row) => row.externalBundleId.startsWith('pending:'))
const sentRows = () => [...links.values()].filter((row) => row.externalBundleId.startsWith('pending:sent:'))

async function runSync() {
  const { runBundleSyncForProduct } = await import('../lib/connectors/mintsoft/sync/bundle-sync')
  return runBundleSyncForProduct(PRODUCT_ID, 'manual')
}

test('a create whose answer was lost KEEPS its claim', async () => {
  putMode = 'drop-unseen'
  const first = await runSync()
  console.log(`precondition: run 1 sent ${puts()} PUT; status=${first.status}; claim rows after run 1=${sentinelRows().length}`)
  assert.equal(puts(), 1, 'the create was sent once')
  assert.equal(first.status, 'ERROR')
  assert.equal(sentinelRows().length, 1, 'the claim is still held after a create that may have been sent')
})

test('and the next run sends NO second PUT while the first create is unaccounted for, though it looks the bundle up', async () => {
  putMode = 'drop-unseen'
  await runSync()
  const putsAfterFirst = puts()
  const lookupsAfterFirst = lookups()
  const second = await runSync()
  console.log(`precondition: PUTs after run 1=${putsAfterFirst}, after run 2=${puts()}; lookups ${lookupsAfterFirst} then ${lookups()}; run 2 status=${second.status}`)
  assert.equal(putsAfterFirst, 1)
  assert.equal(puts(), 1, 'NO second PUT')
  assert.ok(lookups() > lookupsAfterFirst, 'run 2 looked the bundle up (a read) before deciding anything')
  assert.notEqual(second.status, 'SYNCED')
})

test('a create that Mintsoft acted on but answered badly is reconciled by a lookup in the same run and bound, with one PUT', async () => {
  putMode = 'drop-after-registering'
  const result = await runSync()
  console.log(`precondition: PUTs=${puts()} lookups=${lookups()} status=${result.status} action=${result.action}`)
  assert.equal(puts(), 1)
  assert.ok(requestLog.indexOf('PUT /api/Product/Bundle') < requestLog.lastIndexOf('GET /api/Product/500/Bundle'), 'the lookup came after the PUT')
  assert.equal(result.status, 'SYNCED')
  assert.equal(result.externalBundleId, '900')
  const bound = [...links.values()]
  assert.equal(bound.length, 1)
  assert.equal(bound[0]!.externalBundleId, '900', 'the link carries the real bundle id, not the claim')
  assert.equal(sentinelRows().length, 0)
})

test('a lookup that finds a bundle which does not match IMS binds nothing, keeps the claim and sends nothing more', async () => {
  putMode = 'drop-after-registering-different'
  const result = await runSync()
  console.log(`precondition: PUTs=${puts()} status=${result.status} claim rows=${sentinelRows().length} discrepancies=${discrepancies.length}`)
  assert.equal(puts(), 1)
  assert.equal(result.status, 'CONFLICT')
  assert.equal(sentinelRows().length, 1, 'the claim stays: the create may have been the one that made this bundle')
  assert.equal([...links.values()].filter((row) => row.externalBundleId === '900').length, 0, 'an unmatched bundle is never bound')
  await runSync()
  assert.equal(puts(), 1, 'and a later run does not create again either')
})

test('after the claim goes stale a run LOOKS FIRST: a bundle that has appeared is bound and nothing is sent', async () => {
  putMode = 'drop-unseen'
  await runSync()
  assert.equal(puts(), 1)
  const claim = sentinelRows()[0]!
  claim.updatedAt = new Date(Date.now() - 11 * 60 * 1000)
  registered = { id: '900', components: MATCHING } // the first create lands late
  requestLog.length = 0
  const result = await runSync()
  console.log(`precondition: claim aged 11 minutes, bundle now readable; run 2 requests=${JSON.stringify(requestLog)}`)
  assert.equal(requestLog.filter((line) => line === 'PUT /api/Product/Bundle').length, 0, 'no PUT: the lookup found the bundle')
  assert.ok(requestLog.includes('GET /api/Product/500/Bundle'))
  assert.equal(result.status, 'SYNCED')
  assert.equal(sentinelRows().length, 0)
})

test('LEASE EXPIRY NEVER AUTHORISES A SECOND PUT: a SENT claim, aged far past the lease, with nothing readable, sends nothing and stays', async () => {
  putMode = 'drop-unseen'
  await runSync()
  const claim = sentRows()[0]!
  claim.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000)
  requestLog.length = 0
  const result = await runSync()
  console.log(`precondition: sent claim aged 48 hours, nothing readable; run 2 requests=${JSON.stringify(requestLog)} status=${result.status}; discrepancies=${discrepancies.length}`)
  assert.equal(sentRows().length, 1, 'the claim is still a SENT claim')
  assert.ok(requestLog.includes('GET /api/Product/500/Bundle'), 'a lookup was made')
  assert.equal(requestLog.filter((line) => line === 'PUT /api/Product/Bundle').length, 0, 'no PUT, however old the claim')
  assert.equal(result.status, 'CONFLICT')
  assert.match(result.reason, /resolve the claim on Sync > Mintsoft > Bundles/)
  assert.ok(discrepancies.some((row) => String(row.message).includes('Sync > Mintsoft > Bundles')), 'it is raised on the existing conflict surface')
})

test('an UNREADABLE 200 and a 404 are the same non-answer: neither releases a SENT claim nor allows a PUT', async () => {
  for (const unreadable of [true, false]) {
    links.clear(); requestLog.length = 0; registered = null; discrepancies.length = 0
    putMode = 'drop-unseen'
    await runSync()
    sentRows()[0]!.updatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
    garbageLookup = unreadable
    requestLog.length = 0
    await runSync()
    console.log(`precondition (${unreadable ? 'unreadable 200' : '404'}): requests=${JSON.stringify(requestLog)} sent claims=${sentRows().length}`)
    assert.equal(requestLog.filter((line) => line === 'PUT /api/Product/Bundle').length, 0)
    assert.equal(sentRows().length, 1)
    garbageLookup = false
  }
})

test('an UNSENT claim (its worker stopped before the request was handed over) is retaken after the lease, looking first, and sends one PUT', async () => {
  links.set('link-x', { id: 'link-x', connector: 'mintsoft', productId: PRODUCT_ID, externalBundleId: `pending:unsent:${Date.now() - 3_600_000}`, checksum: null, lastSyncedAt: null, updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
  putMode = 'ok'
  const result = await runSync()
  console.log(`precondition: unsent claim aged an hour; requests=${JSON.stringify(requestLog)} status=${result.status}`)
  assert.ok(requestLog.indexOf('GET /api/Product/500/Bundle') < requestLog.indexOf('PUT /api/Product/Bundle'), 'looked first')
  assert.equal(puts(), 1)
  assert.equal(result.status, 'SYNCED')
})

test('the claim is marked SENT before the request leaves: a PUT is never in flight over an unmarked claim', async () => {
  const observed: string[] = []
  putMode = 'drop-unseen'
  // Record the claim's stored value at the instant the listener receives the PUT.
  const seen = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (requestLog.includes('PUT /api/Product/Bundle')) { observed.push([...links.values()].map((row) => row.externalBundleId).join(',')); clearInterval(check); resolve() }
    }, 1)
  })
  const run = runSync()
  await seen
  await run
  console.log(`precondition: claim value when the PUT arrived: ${JSON.stringify(observed)}`)
  assert.equal(observed.length, 1)
  assert.match(observed[0]!, /^pending:sent:\d+$/)
})

test('a complete-looking answer with one UNREADABLE extra component entry is not a match: nothing is bound, the claim stays', async () => {
  putMode = 'drop-after-registering'
  extraMalformedComponent = true
  const result = await runSync()
  console.log(`precondition: PUTs=${puts()} status=${result.status} sent claims=${sentRows().length} bound rows=${[...links.values()].filter((row) => !row.externalBundleId.startsWith('pending:')).length}`)
  assert.equal(puts(), 1)
  assert.notEqual(result.status, 'SYNCED')
  assert.equal(sentRows().length, 1)
  assert.match(result.reason, /incomplete \(1 component entry could not be read\)/)
  extraMalformedComponent = false
})

test('the same incomplete answer on an ORDINARY pre-create lookup binds nothing and creates nothing', async () => {
  registered = { id: '900', components: MATCHING }
  extraMalformedComponent = true
  const result = await runSync()
  console.log(`precondition: status=${result.status} PUTs=${puts()} links=${links.size}`)
  assert.equal(puts(), 0)
  assert.equal(links.size, 0)
  assert.equal(result.status, 'ERROR')
  extraMalformedComponent = false
})

const AGE = (ms: number) => new Date(Date.now() - ms)

test('operator path: LINK binds the claim to the Mintsoft id the operator found; a stale page and a bad id change nothing', async () => {
  const { resolveKeptBundleClaim, listKeptBundleClaims } = await import('../lib/connectors/mintsoft/sync/bundle-claim-resolution')
  putMode = 'drop-unseen'
  await runSync()
  const claim = sentRows()[0]!
  const listed = await listKeptBundleClaims()
  console.log(`precondition: listed kept claims=${listed.total}; claim=${claim.externalBundleId}`)
  assert.equal(listed.total, 1)
  const stale = await resolveKeptBundleClaim({ claimId: claim.id, claimValue: 'pending:sent:1', resolution: { kind: 'absent' }, userId: 'u1' })
  assert.equal(stale.success, false)
  const badId = await resolveKeptBundleClaim({ claimId: claim.id, claimValue: claim.externalBundleId, resolution: { kind: 'link', externalBundleId: '12; DROP' }, userId: 'u1' })
  assert.equal(badId.success, false)
  assert.equal(sentRows().length, 1, 'neither changed the claim')
  mutationEvents.length = 0; activities.length = 0
  const linked = await resolveKeptBundleClaim({ claimId: claim.id, claimValue: claim.externalBundleId, resolution: { kind: 'link', externalBundleId: '900' }, userId: 'u1' })
  assert.equal(linked.success, true)
  assert.equal(links.get(claim.id)?.externalBundleId, '900')
  assert.equal(links.get(claim.id)?.checksum, null, 'no checksum: the next check compares it with IMS')
  assert.equal(mutationEvents.length, 1, 'one durable audit row, written in the same transaction')
  assert.equal(activities.length, 1)
})

test('RELEASE WHILE THE CREATE MAY STILL BE IN FLIGHT IS REFUSED: a fresh claim stays, and a later sync sends no second PUT', async () => {
  const { resolveKeptBundleClaim } = await import('../lib/connectors/mintsoft/sync/bundle-claim-resolution')
  const { bundleReleaseTooSoonText, currentBundleCreateInFlightWindowMs, bundleReleaseWindowMinutes } = await import('../lib/connectors/mintsoft/sync/bundle-create-outcome')
  putMode = 'drop-unseen'
  await runSync()
  const claim = sentRows()[0]!
  const minutes = bundleReleaseWindowMinutes(currentBundleCreateInFlightWindowMs())
  const result = await resolveKeptBundleClaim({ claimId: claim.id, claimValue: claim.externalBundleId, resolution: { kind: 'absent' }, userId: 'u1' })
  console.log(`precondition: window=${minutes} minutes; claim age ~0; result=${JSON.stringify(result).slice(0, 90)}`)
  assert.equal(minutes, 12, '14 timed requests x 30 s + 5 minutes')
  assert.deepEqual(result, { success: false, error: bundleReleaseTooSoonText(minutes) })
  assert.equal(sentRows().length, 1, 'the claim is kept')
  await runSync()
  assert.equal(puts(), 1, 'and a sync after the refused release still sends no second PUT')
  const listed = await (await import('../lib/connectors/mintsoft/sync/bundle-claim-resolution')).listKeptBundleClaims()
  assert.equal(listed.claims[0]!.releaseBlockedReason, bundleReleaseTooSoonText(minutes), 'the page shows the same sentence')
})

test('release once the window has passed needs a FRESH readable "no bundle": found / unreadable / failed all refuse, absent (404 or an empty 200) releases', async () => {
  const { resolveKeptBundleClaim } = await import('../lib/connectors/mintsoft/sync/bundle-claim-resolution')
  const { bundleReleaseLookupRefusalText } = await import('../lib/connectors/mintsoft/sync/bundle-create-outcome')
  putMode = 'drop-unseen'
  await runSync()
  const claim = sentRows()[0]!
  claim.updatedAt = AGE(60 * 60 * 1000)
  const attempt = () => resolveKeptBundleClaim({ claimId: claim.id, claimValue: claim.externalBundleId, resolution: { kind: 'absent' }, userId: 'u1' })

  registered = { id: '900', components: MATCHING }
  const found = await attempt()
  garbageLookup = true; registered = null
  const unreadable = await attempt()
  garbageLookup = false; lookupFails = true
  const failed = await attempt()
  console.log(`precondition: found=${found.success ? 'released' : (found as { error: string }).error.slice(0, 40)} unreadable=${unreadable.success} failed=${failed.success}; claim still held=${sentRows().length}`)
  assert.deepEqual(found, { success: false, error: bundleReleaseLookupRefusalText('found', '900') })
  assert.deepEqual(unreadable, { success: false, error: bundleReleaseLookupRefusalText('unreadable') })
  assert.equal(failed.success, false)
  assert.equal(sentRows().length, 1, 'no refusal released the claim')

  lookupFails = false
  emptyLookup = true
  mutationEvents.length = 0
  const released = await attempt()
  assert.equal(released.success, true)
  assert.equal(links.size, 0, 'the claim is released')
  assert.match(String(mutationEvents[0]?.summary), /did not verify the statement/)
  assert.equal((mutationEvents[0]?.after as { verifiedByIms: boolean }).verifiedByIms, false)
  assert.equal((await attempt()).success, false, 'a second click on the same claim does nothing')
  // and a plain 404 releases too
  emptyLookup = false
  requestLog.length = 0
  await runSync() // creates again (claim was released), leaving a new sent claim
  const second = sentRows()[0]!
  second.updatedAt = AGE(60 * 60 * 1000)
  const viaNotFound = await resolveKeptBundleClaim({ claimId: second.id, claimValue: second.externalBundleId, resolution: { kind: 'absent' }, userId: 'u1' })
  assert.equal(viaNotFound.success, true)
})

test('the claim transition and the audit row commit TOGETHER: when the audit cannot be written nothing is released or linked', async () => {
  const { resolveKeptBundleClaim } = await import('../lib/connectors/mintsoft/sync/bundle-claim-resolution')
  putMode = 'drop-unseen'
  await runSync()
  const claim = sentRows()[0]!
  claim.updatedAt = AGE(60 * 60 * 1000)
  const before = claim.externalBundleId
  auditFails = true
  mutationEvents.length = 0; activities.length = 0
  const release = await resolveKeptBundleClaim({ claimId: claim.id, claimValue: before, resolution: { kind: 'absent' }, userId: 'u1' })
  const link = await resolveKeptBundleClaim({ claimId: claim.id, claimValue: before, resolution: { kind: 'link', externalBundleId: '900' }, userId: 'u1' })
  console.log(`precondition: audit write fails; release=${release.success} link=${link.success}; claim=${links.get(claim.id)?.externalBundleId}; activity entries=${activities.length}`)
  assert.equal(release.success, false)
  assert.equal(link.success, false)
  assert.match((release as { error: string }).error, /audit record of this decision could not be saved/)
  assert.equal(links.get(claim.id)?.externalBundleId, before, 'the claim is exactly as it was')
  assert.equal(activities.length, 0, 'and nothing claims it happened')
})

test('LEGACY pending:<time> claims (written before the two-step format; a crash after a successful PUT left the same shape) are quarantined, never retaken by the clock', async () => {
  links.set('link-legacy', { id: 'link-legacy', connector: 'mintsoft', productId: PRODUCT_ID, externalBundleId: `pending:${Date.now() - 86_400_000}`, checksum: null, lastSyncedAt: null, updatedAt: AGE(24 * 60 * 60 * 1000) })
  const result = await runSync()
  const { listKeptBundleClaims } = await import('../lib/connectors/mintsoft/sync/bundle-claim-resolution')
  const listed = await listKeptBundleClaims()
  console.log(`precondition: legacy claim aged a day; PUTs=${puts()} status=${result.status}; listed for an operator=${listed.total}`)
  assert.equal(puts(), 0, 'no PUT over a legacy claim')
  assert.equal(result.status, 'CONFLICT')
  assert.equal(listed.total, 1, 'it is listed where an operator can resolve it')
})

test('EVERY kept claim is reachable: 120 claims page through completely and a SKU search finds one', async () => {
  const { listKeptBundleClaims, KEPT_BUNDLE_CLAIMS_PAGE_SIZE } = await import('../lib/connectors/mintsoft/sync/bundle-claim-resolution')
  for (let n = 0; n < 120; n += 1) {
    const id = `bulk-${String(n).padStart(3, '0')}`
    links.set(id, { id, connector: 'mintsoft', productId: `p-${n}`, externalBundleId: `pending:sent:${1000 + n}`, checksum: null, lastSyncedAt: null, updatedAt: AGE((200 - n) * 60_000), sku: `BULK-${String(n).padStart(3, '0')}` })
  }
  const seen = new Set<string>()
  let page = 0
  let total = 0
  for (;;) {
    const result = await listKeptBundleClaims({ page })
    total = result.total
    result.claims.forEach((claim) => seen.add(claim.id))
    if (result.claims.length < KEPT_BUNDLE_CLAIMS_PAGE_SIZE) break
    page += 1
  }
  const search = await listKeptBundleClaims({ query: 'bulk-077' })
  console.log(`precondition: ${total} claims, page size ${KEPT_BUNDLE_CLAIMS_PAGE_SIZE}, ${page + 1} pages walked, ${seen.size} distinct reached; search hit=${search.claims.map((claim) => claim.sku)}`)
  assert.equal(total, 120)
  assert.equal(seen.size, 120, 'none is beyond reach')
  assert.deepEqual(search.claims.map((claim) => claim.sku), ['BULK-077'])
})

test('a create the installation never sent (outbound-write hold) releases its claim, so the next run is free to try', async () => {
  delete process.env.MINTSOFT_WRITE_ALLOWED // no grant: the hold refuses the PUT before it leaves
  const result = await runSync()
  console.log(`precondition: no write grant; PUTs that reached the listener=${puts()}; status=${result.status}; claim rows=${sentinelRows().length}`)
  assert.equal(puts(), 0, 'the hold stopped the request: nothing reached the listener')
  assert.equal(result.status, 'ERROR')
  assert.equal(sentinelRows().length, 0, 'a request that never left leaves no claim behind')
  assert.equal(links.size, 0)
})

test('operator text: one wording for the result and the audit row, true for every lookup outcome, and no instruction that is unsafe if a bundle exists', async () => {
  const texts: string[] = []
  const cases: Array<[string, PutMode, boolean]> = [
    ['not found', 'drop-unseen', false],
    ['lookup failed', 'drop-unseen', true],
    ['found, differs', 'drop-after-registering-different', false],
    ['found, matches', 'drop-after-registering', false],
    ['found, incomplete', 'drop-after-registering', false],
  ]
  for (const [label, mode, failLookup] of cases) {
    extraMalformedComponent = label === 'found, incomplete'
    links.clear(); mutationEvents.length = 0; requestLog.length = 0; registered = null
    putMode = mode
    lookupFails = failLookup
    const result = await runSync()
    texts.push(result.reason)
    assert.equal(puts(), 1, label)
    const event = mutationEvents.find((candidate) => candidate.action === 'bundle_create')
    assert.ok(event, `${label}: an audit row was written`)
    if (label !== 'found, matches') assert.equal(String(event!.error ?? ''), result.reason, `${label}: the audit row carries the very sentence the result carries`)
    assert.match(result.reason, /may have reached Mintsoft/, label)
    assert.doesNotMatch(result.reason, /nothing was (created|sent)|no bundle (was|exists)|was not created/i, `${label}: never asserts the bundle is absent`)
    assert.deepEqual(unconditionalMoneySentences(result.reason), [], `${label}: no unconditional instruction`)
    assert.deepEqual(unlicensedHistoryClaims(result.reason, null), [], `${label}: no unlicensed history claim`)
    requestLog.length = 0
  }
  console.log(`precondition: ${texts.length} outcome wordings checked: ${JSON.stringify(texts.map((text) => text.slice(0, 40)))}`)
  assert.equal(texts.length, cases.length)
  assert.equal(new Set(texts).size, cases.length, 'the outcomes read differently')
  extraMalformedComponent = false
  const detail = texts[0]!.match(/answer was not usable \((.*?)\)\./)?.[1]
  assert.ok(detail, 'the failure detail is carried')
  assert.equal(texts[0], bundleCreateMaybeSentText('KIT-1', detail!, { kind: 'not-found' }), 'the result is the single-sourced sentence')
})
