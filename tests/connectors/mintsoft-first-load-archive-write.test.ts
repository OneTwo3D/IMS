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
import { ARCHIVE_RETIREMENT_ATTESTATION_KIND, ARCHIVE_RETIREMENT_MAX_AGE_MS, ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS, archiveHopRefusal, archivePreflight, archiveRetirementEvidence, archiveSwitchoverCheckEvidence, changedMintsoftProductFields, createMintsoftArchiveWiring, createMintsoftArchiveWriter, discontinueMintsoftProduct, mintsoftMessage, targetHoldRefusal, ARCHIVE_USER_AGENT } from '../../lib/connectors/mintsoft/first-load-archive-write.ts'
import { WmsCensusRefused } from '../../lib/first-load/wms-discontinue/cli.ts'
import { KEY, LIVE_FROM, configOf, fakeMintsoft as fakeTenant, grantedEnv, liveEnv, reportInstant, retirementRow, stockRow, switchoverCheckRow, syntheticProduct, type FakeTenant, type Rig } from './mintsoft-archive-fake.ts'
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

// [mutation: the preflight passes without step M live, with a grant for another tenant, or without the retirement evidence] (#1128 R1 MED-3, LOW-2; R2 MED-A)
// The hold check is defence in depth and cannot refuse alone (#1128 R2 LOW-H): a LIVE disposition is the live phase the hold releases, which the second
// assertion shows, so this test does not claim to prove a hold refusal.
test('the preflight, on the TARGET environment: step M live (grant + live-from reached), a grant for exactly this tenant and the target\'s retirement evidence; evidence names the instant', async () => {
  const rig = await fakeMintsoft(tenantOf())
  const config = configOf(rig)
  const facts = { retirement: retirementRow(), switchoverCheck: switchoverCheckRow(), now: new Date() }
  const ok = archivePreflight(config, liveEnv(rig), facts)
  assert.ok(ok.ok)
  assert.match(ok.evidence, new RegExp(`since ${LIVE_FROM.replace('Z', '')}`))
  assert.match(ok.retirementEvidence, /^bridge-units-masked attestation recorded .* judged as writers:check judges it against MINTSOFT_WRITES_LIVE_FROM 2026-01-01T00:00:00.000Z$/)
  assert.ok(archivePreflight(config, { ...liveEnv(rig), PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }, facts).ok, 'a LIVE disposition is the hold\'s live phase: the hold check cannot refuse on its own')
  assert.match(ok.switchoverEvidence, /^writers:check record of the target: verdict ok, phase P2-M, generated .*, step M live since 2026-01-01T00:00:00.000Z$/)
  const none = archivePreflight(config, liveEnv(rig), { ...facts, retirement: null })
  assert.equal(none.ok, false)
  assert.match((none as { problem: string }).problem, /holds no bridge-units-masked attestation/)
  const noCheck = archivePreflight(config, liveEnv(rig), { ...facts, switchoverCheck: null })
  assert.equal(noCheck.ok, false)
  assert.match((noCheck as { problem: string }).problem, /holds no writers:check record/)
  const cases: Array<[Record<string, string>, RegExp]> = [
    [grantedEnv(rig), /Mintsoft step \(M\) is not live in the target installation \(producer decision SHADOW: no_cutoff\)/],
    [{ ...liveEnv(rig), MINTSOFT_WRITES_LIVE_FROM: '2999-01-01T00:00:00Z' }, /not live .*before_cutoff/],
    [{ E2E_TEST_MODE: '1', NODE_ENV: 'test', MINTSOFT_WRITES_LIVE_FROM: LIVE_FROM }, /not live .*no_grant/],
    [{ ...liveEnv(rig), MINTSOFT_WRITE_ALLOWED: `${rig.base}|90` }, /does not admit POST \/api\/Product to the credentials file's tenant/],
    [{ ...liveEnv(rig), MINTSOFT_WRITE_ALLOWED: `http://127.0.0.1:1|89` }, /does not admit POST/],
  ]
  for (const [env, why] of cases) {
    const r = archivePreflight(config, env, facts)
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
  assert.ok(writer.preflight({ retirement: retirementRow(), switchoverCheck: switchoverCheckRow(), now: new Date() }).ok, 'the writer runs under the target environment it was given')
  assert.ok(writer.judgeSwitchoverCheck(switchoverCheckRow(), new Date()).ok)
  assert.throws(() => wiring.openWriter('/synthetic/other.env', liveEnv(rig)), WmsCensusRefused)
})

// [mutation: the retirement evidence is not required, not judged against the step-M instant, or an old report is believed] (#1128 R2 MED-A)
// It covers what the HOST report can show of a rollback; a rollback that resumes the bridge or the plugin BEFORE the live-from is unset leaves a passing
// attestation behind, and is the switchover check's to catch (the tests below) (#1129 R1 LOW-2).
test('the retirement evidence: the target\'s newest bridge-units-masked attestation, judged as writers:check judges it; stage refuses, and so does a host report that shows the bridge back, a re-dated M or a stale report', () => {
  assert.equal(ARCHIVE_RETIREMENT_ATTESTATION_KIND, 'bridge-units-masked')
  const now = new Date()
  const env = { MINTSOFT_WRITE_ALLOWED: 'https://ms.example.test|89', MINTSOFT_WRITES_LIVE_FROM: LIVE_FROM }
  const ok = archiveRetirementEvidence(retirementRow({ now: now.getTime() }), env, now)
  assert.ok(ok.ok, JSON.stringify(ok))
  assert.match(ok.evidence, /last trigger 2025-12-31T23:55:01.000Z; units masked and inactive/)
  const refused = (row: Parameters<typeof archiveRetirementEvidence>[0], why: RegExp, e: Record<string, string> = env) => {
    const r = archiveRetirementEvidence(row, e, now)
    assert.equal(r.ok, false, String(why))
    assert.match((r as { problem: string }).problem, why)
  }
  // Stage during its proof window: LIVE_FROM and the grant set, wired to the live tenant, and no bridge attestation (stage has no bridge).
  refused(null, /the target installation holds no bridge-units-masked attestation/)
  // Step M not live in that environment (unset, or still in the future).
  refused(retirementRow(), /Mintsoft step \(M\) is not live in the target installation/, { MINTSOFT_WRITE_ALLOWED: env.MINTSOFT_WRITE_ALLOWED })
  refused(retirementRow(), /Mintsoft step \(M\) is not live/, { ...env, MINTSOFT_WRITES_LIVE_FROM: '2999-01-01T00:00:00Z' })
  // An M rollback: the bridge's units unmasked again (a report taken after the hand-back) ...
  refused(retirementRow({ units: { 'wc-mintsoft-order-sweep.timer': 'LoadState=loaded ActiveState=active UnitFileState=enabled' } }), /does not show the bridge retired, as writers:check judges it: .*bridge-unit-not-masked/)
  // ... the bridge ran again after S ...
  refused(retirementRow({ lastTrigger: reportInstant(now.getTime() - 7_200_000) }), /shows a trigger at .*, not before MINTSOFT_WRITES_LIVE_FROM/)
  // ... M retried later with a new live-from: the attestation of the first M predates it ...
  const retried = { ...env, MINTSOFT_WRITES_LIVE_FROM: reportInstant(now.getTime() - 1_800_000) }
  refused(retirementRow({ lastTrigger: reportInstant(now.getTime() - 86_400_000) }), /was generated before MINTSOFT_WRITES_LIVE_FROM/, retried)
  // ... or the report is simply old: it says nothing about the host after a rollback resumed the bridge.
  refused(retirementRow({ generatedAt: reportInstant(now.getTime() - ARCHIVE_RETIREMENT_MAX_AGE_MS - 60_000) }), /more than 24 hours before this run/)
  assert.ok(archiveRetirementEvidence(retirementRow({ generatedAt: reportInstant(now.getTime() - ARCHIVE_RETIREMENT_MAX_AGE_MS + 60_000) }), env, now).ok, 'just inside the age limit')
  // A stored payload that is not the shape writers:check reads, or an unreadable time.
  refused({ attestedAt: now.toISOString(), payload: { schema: 1 } }, /does not show the bridge retired/)
  refused({ attestedAt: 'not a time', payload: retirementRow().payload }, /carries a time that cannot be read/)
})

// [mutation: a 200 without a {Success} boolean is read as "nothing was sent", or as an answer] (#1128 R2 LOW-C, MED-B :199)
test('HTTP 200 with {}, with Success not a boolean, or with a non-JSON body: sent unknown (the request left), never an answer', async () => {
  const answers: Array<{ status?: number; body: unknown } | { text: string; contentType: string }> = [
    { body: {} },
    { body: { Success: 'true', Message: 'Product Successfully Updated!' } },
    { text: 'Product Successfully Updated!', contentType: 'text/plain' },
    { text: '{"Success": tru', contentType: 'application/json' },
  ]
  for (const answer of answers) {
    const rig = await fakeMintsoft({ ...tenantOf(), onPost: () => answer })
    const r = await discontinueMintsoftProduct(configOf(rig), '501', 'SYN-A', { env: grantedEnv(rig) })
    assert.deepEqual(r, { ok: false, sent: 'unknown', problem: 'Mintsoft answered HTTP 200 without a {Success, Message} body' }, JSON.stringify(answer))
    assert.equal(rig.seen.filter((x) => x.method === 'POST').length, 1)
  }
})

// [mutation: the stock row's warehouse, client or SKU is not compared, a repeated row is summed, or a negative level is read] (#1128 R2 MED-B :288, :289, :293)
test('a stock row for the product that names another warehouse, another client, no warehouse, another SKU, or appears twice refuses the stock read', async () => {
  const cases: Array<[Array<Record<string, unknown>>, RegExp]> = [
    [[{ ...stockRow(501, 'SYN-A', 0), WarehouseId: 6 }], /a stock row of warehouse 5 for product 501 does not name that warehouse and our client/],
    [[{ ...stockRow(501, 'SYN-A', 0), ClientId: 90 }], /does not name that warehouse and our client/],
    [[Object.fromEntries(Object.entries(stockRow(501, 'SYN-A', 0)).filter(([k]) => k !== 'WarehouseId'))], /does not name that warehouse and our client/],
    [[stockRow(501, 'syn-a', 0)], /the stock of warehouse 5 names product 501 under another SKU/],
    [[stockRow(501, 'SYN-A', 0), stockRow(501, 'syn-a', 0)], /product 501 appears more than once in the stock of warehouse 5/],
    [[stockRow(501, 'SYN-A', 0), stockRow(501, 'SYN-A', 0)], /the stock of warehouse 5 is unreadable/],
    [[stockRow(501, 'SYN-A', -1)], /the stock of warehouse 5 is unreadable/],
  ]
  for (const [rows, why] of cases) {
    const t = tenantOf()
    t.stock['5'] = rows
    const rig = await fakeMintsoft(t)
    const writer = createMintsoftArchiveWriter(configOf(rig), { env: grantedEnv(rig), sleep: noSleep })
    const r = await writer.readStock('501', 'SYN-A')
    assert.equal(r.ok, false, JSON.stringify(rows))
    assert.match((r as { problem: string }).problem, why)
  }
})

// [mutation: a warehouse listed twice is accepted, or a row in a warehouse nobody configured counts as the stock row] (#1128 R2 LOW-G :259, :294)
test('the warehouse list must not hold a warehouse twice; a stock row only in an unconfigured warehouse is no stock row (its stock still counts)', async () => {
  const twice = tenantOf()
  twice.warehouses = [{ ID: 5 }, { ID: 5 }]
  const r1 = await fakeMintsoft(twice)
  const w1 = createMintsoftArchiveWriter(configOf(r1), { env: grantedEnv(r1), sleep: noSleep })
  assert.deepEqual(await w1.readStock('501', 'SYN-A'), { ok: false, problem: 'the warehouse list holds a warehouse without a usable id, or one twice' })
  assert.deepEqual(r1.seen.map((x) => x.url), ['/api/Warehouse'], 'no stock read after the list is refused')
  const elsewhere = tenantOf()
  elsewhere.warehouses = [{ ID: 5 }, { ID: 7 }]
  elsewhere.stock = { '5': [], '7': [stockRow(501, 'SYN-A', 4, 7)] }
  const r2 = await fakeMintsoft(elsewhere)
  const w2 = createMintsoftArchiveWriter(configOf(r2), { env: grantedEnv(r2), sleep: noSleep })
  assert.deepEqual(await w2.readStock('501', 'SYN-A'), { ok: true, value: { stockRow: false, onHand: 4 } })
})

// [mutation: the switchover-check record is not required, a failing or non-INFO one passes, a stale one is believed, or a phase before M passes] (#1129 R1 MED-1)
test('the switchover check: the target\'s newest writers:check record must pass (INFO, verdict ok), be of phase P2-M or later with the same step-M instant, and be under 6 hours old', () => {
  const now = new Date()
  const env = { MINTSOFT_WRITE_ALLOWED: 'https://ms.example.test|89', MINTSOFT_WRITES_LIVE_FROM: LIVE_FROM }
  assert.equal(ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS, 6 * 3_600_000)
  const ok = archiveSwitchoverCheckEvidence(switchoverCheckRow({ now: now.getTime() }), env, now)
  assert.ok(ok.ok, JSON.stringify(ok))
  for (const phase of ['P2-W', 'P2-X']) assert.ok(archiveSwitchoverCheckEvidence(switchoverCheckRow({ report: { phase } }), env, now).ok, phase)
  assert.ok(archiveSwitchoverCheckEvidence(switchoverCheckRow({ generatedAt: new Date(now.getTime() - ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS + 60_000).toISOString() }), env, now).ok, 'just inside the age limit')
  const refused = (row: Parameters<typeof archiveSwitchoverCheckEvidence>[0], why: RegExp, e: Record<string, string> = env) => {
    const r = archiveSwitchoverCheckEvidence(row, e, now)
    assert.equal(r.ok, false, String(why))
    assert.match((r as { problem: string }).problem, why)
  }
  refused(null, /holds no writers:check record/)
  refused(switchoverCheckRow({ level: 'ERROR' }), /did not pass \(level ERROR, verdict ok\)/)
  refused(switchoverCheckRow({ level: 'WARNING' }), /did not pass \(level WARNING/)
  refused(switchoverCheckRow({ report: { verdict: 'double-claim' } }), /did not pass \(level INFO, verdict double-claim\)/)
  refused({ level: 'INFO', createdAt: now.toISOString(), metadata: {} }, /did not pass/)
  refused(switchoverCheckRow({ generatedAt: new Date(now.getTime() - ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS - 60_000).toISOString() }), /more than 6 hours before this run/)
  refused(switchoverCheckRow({ generatedAt: new Date(now.getTime() + 3_600_000).toISOString() }), /cannot be read, or one in the future/)
  refused(switchoverCheckRow({ report: { generatedAt: 'yesterday' } }), /cannot be read, or one in the future/)
  refused(switchoverCheckRow({ report: { phase: 'P1' } }), /is of phase P1, not P2-M or later/)
  refused(switchoverCheckRow({ report: { phase: 'P3' } }), /not P2-M or later/)
  refused(switchoverCheckRow({ report: { steps: [{ step: 'mintsoft', liveFrom: new Date(LIVE_FROM).toISOString(), state: 'scheduled' }] } }), /does not show step M live at the instant the target env file names/)
  refused(switchoverCheckRow(), /does not show step M live/, { ...env, MINTSOFT_WRITES_LIVE_FROM: '2026-02-01T00:00:00Z' })
  refused(switchoverCheckRow(), /does not show step M live/, { MINTSOFT_WRITE_ALLOWED: env.MINTSOFT_WRITE_ALLOWED })
})

// [mutation: a rollback that resumed the bridge and plugin before the live-from was unset is not refused] (#1129 R1 MED-1)
// The rollback ordering the review names: the bridge's plugin reactivated and its sweep running again (a fresh foreign Mintsoft order) while
// MINTSOFT_WRITES_LIVE_FROM is still set, with the host attestation from step M still clean and fresh. writers:check, as the scheduled job records it,
// fails on the companion-plugin probe and the foreign order, and the archive refuses that record. Driven through the real evaluator and recorder.
test('an M rollback that resumed the bridge before the live-from was unset: the retirement attestation still passes, the recorded writers:check fails, and the archive refuses', async () => {
  const { evaluateWritersCheck } = await import('../../lib/ops/writers-check.ts')
  const { runWritersCheckRecord } = await import('../../lib/ops/writers-check-record.ts')
  const { STEP_EVIDENCE_KINDS } = await import('../../lib/security/writers-check-constants.ts')
  const now = new Date()
  const env = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all', MINTSOFT_WRITE_ALLOWED: 'https://ms.example.test|89', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', MINTSOFT_WRITES_LIVE_FROM: LIVE_FROM }
  const evidence = (rolledBack: boolean) => {
    const out: Record<string, unknown> = {}
    for (const kind of STEP_EVIDENCE_KINDS) {
      out[kind] = kind === 'BRIDGE_ATTESTATION' ? { state: 'present', at: new Date(now.getTime() - 3_000_000).toISOString(), violations: [], lastTriggerAt: '2025-12-31T23:55:01.000Z', generatedAt: new Date(now.getTime() - 3_300_000).toISOString() }
        : kind === 'BRIDGE_PROBE' ? { state: 'probed', violations: rolledBack ? ['bridge-route-registered:wc-mintsoft/v1', 'order-sync-enabled'] : [] }
        : kind === 'MINTSOFT_FOREIGN_ORDER' ? { state: 'counted', counted: rolledBack ? 1 : 0, floor: LIVE_FROM }
        : kind.startsWith('QOBLEX') ? { state: 'present', at: '2025-11-01T00:00:00.000Z' }
        : kind === 'NATIVE_EMAIL_EXCLUSIVE' || kind === 'XEROOM_NOTE' ? { state: 'probed', violations: [] }
        : { state: 'counted', counted: 0, floor: LIVE_FROM }
    }
    return out
  }
  const recorded = async (rolledBack: boolean) => {
    let row: { level: string; createdAt: string; metadata: unknown } | null = null
    const report = evaluateWritersCheck({
      env, now, windowDays: 14, settings: new Map([['trackship_refire_enabled', 'true'], ['mintsoft_parent_sku_delete_enabled', 'true'], ['wc_withdrawal_outcome_enabled', 'true']]), cronEnabled: { 'wms-order-push': true },
      pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
      evidence: Object.fromEntries(['MINTSOFT_ORDER_ID', 'MINTSOFT_OTHER_META', 'XEROOM_MARKER', 'XERO_FOREIGN_NUMBER'].map((k) => [k, { counted: 0, total: 0, unpaid: 0, floor: LIVE_FROM }])) as never,
      stepEvidence: evidence(rolledBack) as never, evidenceUnrecorded: 0, unknownEvidenceKinds: 0,
    })
    await runWritersCheckRecord({ build: async () => report, log: (async (entry: { level: string; metadata: unknown }) => { row = { level: entry.level, createdAt: now.toISOString(), metadata: entry.metadata }; return true }) as never })
    return { report, row: row! }
  }
  const before = await recorded(false)
  assert.equal(before.report.verdict, 'ok', JSON.stringify(before.report.findings.filter((f) => f.severity === 'fail')))
  assert.ok(archiveSwitchoverCheckEvidence(before.row, env, now).ok, 'the check before the rollback passes')
  // The host attestation of step M is still clean and fresh: alone it would let the write leave.
  assert.ok(archiveRetirementEvidence(retirementRow({ now: now.getTime() }), env, now).ok)
  const after = await recorded(true)
  assert.notEqual(after.report.verdict, 'ok')
  assert.equal(after.row.level, 'ERROR')
  const r = archiveSwitchoverCheckEvidence(after.row, env, now)
  assert.equal(r.ok, false)
  assert.match((r as { problem: string }).problem, /did not pass \(level ERROR, verdict [a-z-]+\)/)
})
