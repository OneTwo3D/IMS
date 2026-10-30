import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * THE TAX-RATE WRITER'S DEPENDENCIES, BUILT FROM ONE CREDENTIAL RESOLUTION (lib/connectors/woocommerce/tax-rate-session.ts).
 * The settings are read again (`configured`) and have moved on to another store; every GET and every write of the run must still use the PINNED credentials, and nothing may reload the settings
 * for a send. wcPost and wcPut are recorders; the GET transport's fetch seam is a recorder. Nothing here reaches a network.
 */

type WriteCall = { fn: 'wcPost' | 'wcPut'; path: string; creds: unknown }
const writes: WriteCall[] = []
mock.module(new URL('../../lib/connectors/woocommerce/api.ts', import.meta.url).href, {
  namedExports: {
    wcPost: async (path: string, _body: unknown, creds?: unknown) => { writes.push({ fn: 'wcPost', path, creds }); return { data: path === '/taxes' ? { id: 77 } : { delete: [{ id: 9 }] } } },
    wcPut: async (path: string, _body: unknown, creds?: unknown) => { writes.push({ fn: 'wcPut', path, creds }); return { data: { id: 5 } } },
  },
})

const A = { url: 'https://store-a.example', key: 'ck_A', secret: 'cs_A' }
const B = { url: 'https://store-b.example', key: 'ck_B', secret: 'cs_B' }
const RATE = { id: 5, name: 'GB VAT', rate: '20.0000', country: 'GB', state: '', postcode: '', city: '', class: 'standard', shipping: true, compound: false }

type Fetched = { url: string; method: string | undefined; authorization: string | undefined }
function fetchSpy(seen: Fetched[]) {
  return (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url))
    seen.push({ url: u.href, method: init?.method, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization })
    const body = /\/taxes\/5$/.test(u.pathname) ? RATE : Number(u.searchParams.get('page')) === 1 ? [RATE] : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1' } })
  }) as never
}

test('the GET reads and the write port use the pinned credentials, whatever the settings say afterwards; the configured identity is the one thing read live', async () => {
  const { createWooTaxWriterDeps } = await import('../../lib/connectors/woocommerce/tax-rate-session.ts')
  const seen: Fetched[] = []
  let configuredReads = 0
  const deps = createWooTaxWriterDeps({
    pinned: A,
    configured: async () => { configuredReads += 1; return B },
    transport: { fetchImpl: fetchSpy(seen), env: { E2E_TEST_MODE: '1', NODE_ENV: 'test' } },
  })
  writes.length = 0
  assert.equal(await deps.storeIdentity(), 'https://store-a.example')
  assert.equal(configuredReads, 0, 'the pinned identity does not read the settings')
  assert.equal((await deps.readWoo()).ok, true)
  assert.equal((await deps.readWooRate!('5')).ok, true)
  assert.equal((await deps.port!.create({ name: 'x', rate: '1.0000', country: 'GB', state: '', class: 'standard', compound: false, shipping: true })).ok, true)
  assert.equal((await deps.port!.update('5', { rate: '2.0000' })).ok, true)
  assert.equal((await deps.port!.remove('9')).ok, true)
  assert.ok(seen.length >= 3, `GETs were made (${seen.length})`)
  const authA = `Basic ${Buffer.from('ck_A:cs_A').toString('base64')}`
  for (const s of seen) {
    assert.equal(s.method, 'GET')
    assert.ok(s.url.startsWith('https://store-a.example/'), s.url)
    assert.equal(s.authorization, authA)
  }
  assert.ok(seen.some((s) => /\/wp-json\/wc\/v3\/taxes\/5\?/.test(s.url)), 'the single-rate re-read is GET taxes/5')
  assert.equal(writes.length, 3)
  for (const w of writes) assert.strictEqual(w.creds, A, `${w.fn} ${w.path} was handed the pinned credential object`)
  assert.equal(await deps.configuredStoreIdentity!(), 'https://store-b.example', 'the live settings are read only for the comparison')
  assert.equal(configuredReads, 1)
})

test('a run with no usable credentials sends nothing and does not fall back to reloading them: the writes are handed null', async () => {
  const { createWooTaxWriterDeps } = await import('../../lib/connectors/woocommerce/tax-rate-session.ts')
  const seen: Fetched[] = []
  const deps = createWooTaxWriterDeps({ pinned: null, configured: async () => A, transport: { fetchImpl: fetchSpy(seen), env: { E2E_TEST_MODE: '1', NODE_ENV: 'test' } } })
  writes.length = 0
  assert.equal(await deps.storeIdentity(), null)
  assert.equal((await deps.readWoo()).ok, false)
  assert.equal((await deps.readWooRate!('5')).ok, false)
  assert.deepEqual(seen, [])
  await deps.port!.remove('9')
  assert.strictEqual(writes[0]!.creds, null, 'null is passed through: the transport does not reload')
})

test('the real port with no credentials argument still lets the transport reload them (existing callers are unchanged)', async () => {
  const { createWooTaxRateWritePort } = await import('../../lib/connectors/woocommerce/tax-rate-port.ts')
  writes.length = 0
  await createWooTaxRateWritePort().update('5', { rate: '2.0000' })
  assert.strictEqual(writes[0]!.creds, undefined)
})

test('the CLI builds every dependency from the one pinned resolution: no second credential read, no port or GET reader of its own', () => {
  const text = readFileSync(new URL('../../scripts/woo-tax-plan.ts', import.meta.url), 'utf8')
  assert.equal((text.match(/getWcCredentials\(\)/g) ?? []).length, 2, 'one pinned read at the start of the run and the live read handed over for the comparison')
  assert.match(text, /const pinned = await api\.getWcCredentials\(\)/)
  assert.match(text, /createWooTaxWriterDeps\(\{ pinned, configured: \(\) => api\.getWcCredentials\(\)/)
  assert.doesNotMatch(text, /createWooTaxRateWritePort|createStoredWooPort|readWooTaxRateDetails/)
})
