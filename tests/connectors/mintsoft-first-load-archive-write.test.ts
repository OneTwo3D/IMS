/**
 * The first-load Mintsoft archive WRITER (lib/connectors/mintsoft/first-load-archive-write.ts) over a LOOPBACK HTTP double: no real network
 * (tests/no-outbound-network.cjs refuses anything but loopback). The double is a fake Mintsoft tenant holding synthetic products and stock; it records every
 * request, implements the verified answers (a partial {ID, SKU, DisCont} body is accepted with Success:true; a full product body is refused with HTTP 200
 * and Success:false, 'One or more pallet sizes are not valid!') and can be told to misbehave. Synthetic data only.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { after, afterEach, before } from 'node:test'
import { archiveHopRefusal, archivePreflight, changedMintsoftProductFields, createMintsoftArchiveWiring, createMintsoftArchiveWriter, discontinueMintsoftProduct, mintsoftMessage, targetHoldRefusal, ARCHIVE_USER_AGENT } from '../../lib/connectors/mintsoft/first-load-archive-write.ts'
import { WmsCensusRefused } from '../../lib/first-load/wms-discontinue/cli.ts'
import { KEY, LIVE_FROM, configOf, fakeMintsoft as fakeTenant, grantedEnv, liveEnv, stockRow, syntheticProduct, type FakeTenant, type Rig } from './mintsoft-archive-fake.ts'
import { setOutboundRefusalSink } from '../../lib/security/outbound-write-refusal-log.ts'

// A held write is recorded through the refusal sink; here it is counted, never written to a database.
const heldRecorded: string[] = []
before(() => setOutboundRefusalSink(async (error) => { heldRecorded.push(error.code) }))
after(() => setOutboundRefusalSink(null))

const noSleep = async () => {}
const rigs: Rig[] = []
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close() })
const fakeMintsoft = (tenant: FakeTenant) => fakeTenant(tenant, rigs)

function tenantOf(): FakeTenant {
  return { products: new Map([['501', syntheticProduct(501, 'SYN-A')]]), stock: { '5': [stockRow(501, 'SYN-A', 0)] } }
}

// [mutation: the body carries the full product, another field, or no User-Agent] (the verified write shape, 2026-11-21)
test('the discontinue request is POST /api/Product with exactly {ID, SKU, DisCont: true}, the key only in ms-apikey, a User-Agent, and Success:true is accepted', async () => {
  const rig = await fakeMintsoft(tenantOf())
  const writer = createMintsoftArchiveWriter(configOf(rig), { env: grantedEnv(rig), sleep: noSleep })
  const answer = await writer.setDiscontinued('501', 'SYN-A')
  assert.deepEqual(answer, { ok: true, value: { accepted: true, message: 'Product Successfully Updated!' } })
  assert.equal(rig.seen.length, 1)
  assert.equal(rig.seen[0]!.method, 'POST')
  assert.equal(rig.seen[0]!.url, '/api/Product')
  assert.deepEqual(JSON.parse(rig.seen[0]!.body), { ID: 501, SKU: 'SYN-A', DisCont: true })
  assert.deepEqual(Object.keys(JSON.parse(rig.seen[0]!.body)), ['ID', 'SKU', 'DisCont'])
  assert.equal(rig.seen[0]!.apikey, KEY)
  assert.equal(rig.seen[0]!.ua, ARCHIVE_USER_AGENT)
  assert.ok(!rig.seen[0]!.url.includes(KEY))
  assert.equal(rig.tenant.products.get('501')!.DisCont, true)
})

// [mutation: HTTP 200 is read as success] (the pallet-size refusal of a full body, and any Success:false, come back as 200)
test('HTTP 200 with Success:false is NOT accepted: the pallet-size refusal shape and any other Success:false; a 200 without the body is a failure', async () => {
  const pallet = await fakeMintsoft({ ...tenantOf(), onPost: () => ({ body: { Success: false, Message: 'One or more pallet sizes are not valid!', ID: 501 } }) })
  const refused = await discontinueMintsoftProduct(configOf(pallet), '501', 'SYN-A', { env: grantedEnv(pallet) })
  assert.deepEqual(refused, { ok: true, value: { accepted: false, message: 'One or more pallet sizes are not valid!' } })
  const noBody = await fakeMintsoft({ ...tenantOf(), onPost: () => ({ body: [] }) })
  const r = await discontinueMintsoftProduct(configOf(noBody), '501', 'SYN-A', { env: grantedEnv(noBody) })
  assert.equal(r.ok, false)
  const server = await fakeMintsoft({ ...tenantOf(), onPost: () => ({ status: 500, body: { Success: true } }) })
  const s = await discontinueMintsoftProduct(configOf(server), '501', 'SYN-A', { env: grantedEnv(server) })
  assert.deepEqual(s, { ok: false, sent: 'unknown', problem: 'Mintsoft answered HTTP 500' })
})

// [mutation: the writer bypasses the outbound-write grant or the producer hold]
test('without the outbound-write grant, or while the producer hold is enforced and Mintsoft is not live, the POST never leaves (the double sees nothing)', async () => {
  const rig = await fakeMintsoft(tenantOf())
  const noGrant = await discontinueMintsoftProduct(configOf(rig), '501', 'SYN-A', { env: { E2E_TEST_MODE: '1', NODE_ENV: 'test' } })
  assert.equal(noGrant.ok, false)
  assert.match((noGrant as { problem: string }).problem, /held before it left IMS: the target's outbound-write grant/)
  const otherTenant = await discontinueMintsoftProduct(configOf(rig), '501', 'SYN-A', { env: { E2E_TEST_MODE: '1', NODE_ENV: 'test', MINTSOFT_WRITE_ALLOWED: `${rig.base}|90` } })
  assert.equal(otherTenant.ok, false)
  assert.match((otherTenant as { problem: string }).problem, /nothing was sent/)
  const held = await discontinueMintsoftProduct(configOf(rig), '501', 'SYN-A', { env: { ...grantedEnv(rig), PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' } })
  assert.equal(held.ok, false)
  assert.match((held as { problem: string }).problem, /producer hold is enforced/)
  // A refusal before anything left says so: sent is false (#1128 R1 LOW-1).
  for (const r of [noGrant, otherTenant, held]) assert.equal((r as { sent: unknown }).sent, false)
  assert.deepEqual(rig.seen, [], 'nothing reached the tenant')
  assert.ok(heldRecorded.length >= 1, 'the transport recorded the held write')
  assert.equal(rig.tenant.products.get('501')!.DisCont, false)
})

// [mutation: the hop gate admits another path, method, parameter, origin or a redirect]
test('the hop gate admits exactly GET /api/Product/{id}, GET /api/Product/StockLevels?WarehouseId and POST /api/Product, on the connection origin, no redirect', () => {
  const base = new URL('https://ms.example.test/base')
  const hop = (method: string, url: string, redirectCount = 0) => archiveHopRefusal(base, { method, url: new URL(url), redirectCount })
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Product/501'), null)
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Product/StockLevels?WarehouseId=5'), null)
  assert.equal(hop('POST', 'https://ms.example.test/base/api/Product'), null)
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Warehouse'), null)
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Warehouse?x=1'), 'parameter')
  assert.equal(hop('POST', 'https://ms.example.test/base/api/Warehouse'), 'path')
  assert.equal(hop('PUT', 'https://ms.example.test/base/api/Product'), 'method')
  assert.equal(hop('DELETE', 'https://ms.example.test/base/api/Product/501'), 'method')
  assert.equal(hop('POST', 'https://ms.example.test/base/api/Auth'), 'path')
  assert.equal(hop('POST', 'https://ms.example.test/base/api/Product/501'), 'path')
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Order/5/Cancel'), 'path')
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Product/List?PageNo=1&Limit=100'), 'path')
  assert.equal(hop('POST', 'https://ms.example.test/base/api/Product?x=1'), 'parameter')
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Product/501?x=1'), 'parameter')
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Product/StockLevels?WarehouseId=a'), 'parameter')
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Product/StockLevels?WarehouseId=5&x=1'), 'parameter')
  assert.equal(hop('GET', 'https://other.example.test/base/api/Product/501'), 'origin')
  assert.equal(hop('GET', 'https://ms.example.test/api/Product/501'), 'path')
  assert.equal(hop('GET', 'https://ms.example.test/base/api/Product/501', 1), 'redirect')
  // The producer hold's per-hop gate, on the TARGET's environment, is composed in the transport call (the census entry MINT_OPERATOR_TRANSPORT relies on it).
  const source = readFileSync(path.join(process.cwd(), 'lib/connectors/mintsoft/first-load-archive-write.ts'), 'utf8')
  assert.match(source, /const refusal = archiveHopRefusal\(new URL\(config\.baseUrl\), hop\) \?\? targetHoldRefusal\(hop, deps\.env, new URL\(config\.baseUrl\)\)/)
  const post = { method: 'POST', url: new URL('https://ms.example.test/base/api/Product'), redirectCount: 0 }
  assert.equal(targetHoldRefusal(post, {}, base), null, 'legacy: no hold')
  assert.match(targetHoldRefusal(post, { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }, base) ?? '', /producer-side hold is enforced/)
  assert.equal(targetHoldRefusal({ ...post, method: 'GET', url: new URL('https://ms.example.test/base/api/Product/1') }, { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }, base), null, 'a read under the base path is never held')
})

test('the product read gives id, SKU exactly, bundle, flag and client; the stock read sums the configured warehouses and says whether a row exists', async () => {
  const tenant = tenantOf()
  tenant.products.set('502', syntheticProduct(502, 'SYN-B ', { Bundle: true, DisCont: undefined, ClientId: 90 }))
  tenant.stock['6'] = [stockRow(501, 'SYN-A', 2, 6)]
  tenant.warehouses = [{ ID: 5 }, { ID: 6 }]
  const rig = await fakeMintsoft(tenant)
  const writer = createMintsoftArchiveWriter(configOf(rig, ['5', '6']), { env: grantedEnv(rig), sleep: noSleep })
  const a = await writer.readProduct('501')
  assert.ok(a.ok)
  assert.deepEqual({ ...a.value, snapshot: undefined }, { productId: '501', sku: 'SYN-A', bundle: false, discontinued: false, ownClient: true, snapshot: undefined })
  const b = await writer.readProduct('502')
  assert.ok(b.ok)
  assert.deepEqual([b.value.sku, b.value.bundle, b.value.discontinued, b.value.ownClient], ['SYN-B ', true, null, false])
  assert.deepEqual(await writer.readProduct('503'), { ok: false, problem: 'Mintsoft answered HTTP 404' })
  assert.deepEqual(await writer.readStock('501', 'SYN-A'), { ok: true, value: { stockRow: true, onHand: 2 } })
  assert.deepEqual(await writer.readStock('502', 'SYN-B '), { ok: true, value: { stockRow: false, onHand: 0 } })
  assert.ok(rig.seen.every((s) => s.method === 'GET' && s.ua === ARCHIVE_USER_AGENT && s.apikey === KEY))
})

test('the writer paces every request (the interval between any two), never before the first', async () => {
  const rig = await fakeMintsoft(tenantOf())
  const waits: number[] = []
  const writer = createMintsoftArchiveWriter(configOf(rig), { env: grantedEnv(rig), sleep: async (ms) => { waits.push(ms) }, minIntervalMs: 1234 })
  await writer.readProduct('501')
  await writer.readStock('501', 'SYN-A')
  await writer.setDiscontinued('501', 'SYN-A')
  assert.deepEqual(waits, [1234, 1234, 1234], 'product, warehouse list, stock of warehouse 5, then the POST')
})

// [mutation: a changed field is not reported, or LastUpdated / DisCont are reported]
test('changedFields names every other field that differs or appears on one side only; DisCont, LastUpdated and LastUpdatedByUser are ignored', () => {
  const before = syntheticProduct(501, 'SYN-A')
  assert.deepEqual(changedMintsoftProductFields(before, { ...before, DisCont: true, LastUpdated: 'x', LastUpdatedByUser: 'y' }), [])
  assert.deepEqual(changedMintsoftProductFields(before, { ...before, CommodityCode: { Code: '0000000000' } }), [], 'equal nested values')
  assert.deepEqual(changedMintsoftProductFields(before, { ...before, PalletSizes: '', Weight: 0.3, ProductCustomFields: [] }), ['PalletSizes', 'ProductCustomFields', 'Weight'])
  const withoutDescription = Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'Description'))
  assert.deepEqual(changedMintsoftProductFields(before, withoutDescription), ['Description'])
  assert.deepEqual(changedMintsoftProductFields(before, { ...before, Extra: 1 }), ['Extra'])
  assert.deepEqual(changedMintsoftProductFields(before, null), ['(the product answer is not an object)'])
})

test('Mintsoft\'s message is shown printable and short', () => {
  assert.equal(mintsoftMessage('ok\u0000\u001b[2Jdone'), 'ok  [2Jdone')
  assert.equal(mintsoftMessage(undefined), '(no message)')
  assert.equal(mintsoftMessage('x'.repeat(300)).length, 203)
})

// [mutation: only the configured warehouses are re-read, or a same-SKU row under another id is skipped] (#1128 R1 LOW-5, LOW-6)
test('the stock re-read reads EVERY listed warehouse: stock in a warehouse nobody configured counts; a configured one must be listed; a same-SKU row under another product id refuses', async () => {
  const t = tenantOf()
  t.warehouses = [{ ID: 5 }, { ID: 7 }]
  t.stock['7'] = [stockRow(501, 'SYN-A', 3, 7)]
  const rig = await fakeMintsoft(t)
  const writer = createMintsoftArchiveWriter(configOf(rig), { env: grantedEnv(rig), sleep: noSleep })
  assert.deepEqual(await writer.readStock('501', 'SYN-A'), { ok: true, value: { stockRow: true, onHand: 3 } })
  assert.deepEqual(rig.seen.map((x) => x.url), ['/api/Warehouse', '/api/Product/StockLevels?WarehouseId=5', '/api/Product/StockLevels?WarehouseId=7'])
  const unlisted = createMintsoftArchiveWriter(configOf(rig, ['5', '6']), { env: grantedEnv(rig), sleep: noSleep })
  assert.deepEqual(await unlisted.readStock('501', 'SYN-A'), { ok: false, problem: 'configured warehouse(s) 6 are not in the Mintsoft warehouse list' })
  const other = tenantOf()
  other.stock['5'] = [stockRow(999, 'SYN-A', 0)]
  const r2 = await fakeMintsoft(other)
  const w2 = createMintsoftArchiveWriter(configOf(r2), { env: grantedEnv(r2), sleep: noSleep })
  const res = await w2.readStock('501', 'SYN-A')
  assert.equal(res.ok, false)
  assert.match((res as { problem: string }).problem, /holds the SKU under another product id \(999\)/)
})

// [mutation: the preflight passes without step M live, under a hold, or with a grant for another tenant] (#1128 R1 MED-3, LOW-2)
test('the preflight, on the TARGET environment: step M live (grant + live-from reached) and no hold and a grant for exactly this tenant; evidence names the instant', async () => {
  const rig = await fakeMintsoft(tenantOf())
  const config = configOf(rig)
  const ok = archivePreflight(config, liveEnv(rig))
  assert.ok(ok.ok)
  assert.match(ok.evidence, new RegExp(`since ${LIVE_FROM.replace('Z', '')}`))
  const cases: Array<[Record<string, string>, RegExp]> = [
    [grantedEnv(rig), /Mintsoft step \(M\) is not live in the target installation \(producer decision SHADOW: no_cutoff\)/],
    [{ ...liveEnv(rig), MINTSOFT_WRITES_LIVE_FROM: '2999-01-01T00:00:00Z' }, /not live .*before_cutoff/],
    [{ E2E_TEST_MODE: '1', NODE_ENV: 'test', MINTSOFT_WRITES_LIVE_FROM: LIVE_FROM }, /not live .*no_grant/],
    [{ ...liveEnv(rig), MINTSOFT_WRITE_ALLOWED: `${rig.base}|90` }, /does not admit POST \/api\/Product to the credentials file's tenant/],
    [{ ...liveEnv(rig), MINTSOFT_WRITE_ALLOWED: `http://127.0.0.1:1|89` }, /does not admit POST/],
  ]
  for (const [env, why] of cases) {
    const r = archivePreflight(config, env)
    assert.equal(r.ok, false, JSON.stringify(env))
    assert.match((r as { problem: string }).problem, why)
  }
  assert.deepEqual(rig.seen, [], 'the preflight sends nothing')
})

// [mutation: a dropped connection after the POST reads as "nothing was sent"] (#1128 R1 MED-5, LOW-1)
test('a connection dropped after the POST was received is sent: unknown (it may have reached Mintsoft), never retried', async () => {
  const rig = await fakeMintsoft({ ...tenantOf(), onPost: () => 'drop' })
  const r = await discontinueMintsoftProduct(configOf(rig), '501', 'SYN-A', { env: grantedEnv(rig) })
  assert.equal(r.ok, false)
  assert.equal((r as { sent: unknown }).sent, 'unknown')
  assert.match((r as { problem: string }).problem, /may or may not have reached Mintsoft/)
  assert.equal(rig.seen.filter((x) => x.method === 'POST').length, 1, 'no retry')
})

// [mutation: the census and the writer parse the credentials file separately, or accept another file] (#1128 R1 LOW-7)
test('the wiring parses the credentials file once for both the census and the writer, and refuses a writer on another file', async () => {
  const rig = await fakeMintsoft(tenantOf())
  const parsed: string[] = []
  const censusConfigs: unknown[] = []
  const wiring = createMintsoftArchiveWiring({
    readConfig: (file) => { parsed.push(file); return configOf(rig) },
    readCensus: async (config) => { censusConfigs.push(config); return { products: [], physical: new Map(), warehouses: ['5'], clientId: '89', origin: new URL(rig.base).origin } },
    writerDeps: { sleep: noSleep },
  })
  await wiring.reader.read('/synthetic/ms.env')
  const writer = wiring.openWriter('/synthetic/ms.env', liveEnv(rig))
  assert.deepEqual(parsed, ['/synthetic/ms.env'])
  assert.equal(censusConfigs.length, 1)
  assert.ok(writer.preflight().ok, 'the writer runs under the target environment it was given')
  assert.throws(() => wiring.openWriter('/synthetic/other.env', liveEnv(rig)), WmsCensusRefused)
})
