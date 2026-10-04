import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import test, { after, before, mock } from 'node:test'

/**
 * o3d-zvec.3 — THE WOOCOMMERCE WRITEBACK FENCE, PROVEN AGAINST A REAL LOCAL ORIGIN.
 *
 * The hazard: every IMS → WC writeback path (partial shipment, order status, tracking, WMS status
 * meta, stock, product, invoice note, FX, webhook registration) reads only `wc_url` +
 * `wc_webhook_secret`. Nothing named the store this installation is allowed to write to, so the
 * live store's protection was the Mintsoft push cron being off by habit. Duplicate
 * partial-shipment rows and duplicate customer emails are the visible consequence.
 *
 * These tests do NOT assert that a fence exists; they drive the real `wcPut` and the real
 * `pushPartialShipmentToWc` at a LOCAL HTTP LISTENER started here and count what arrives at it.
 * A fence that is present but ineffective fails them, because the assertion is on the listener's
 * request log, not on a return value alone.
 *
 * WHAT WOULD STILL PASS THESE TESTS: a fence that covered `wcPut` and the partial-shipment push
 * but NOT some third path — which is why tests/wc-writeback-fence-coverage.test.ts asserts the
 * chokepoint is the only way out of the connector, and why that file, not this one, is the
 * by-construction half.
 */

type Received = { method: string; url: string; body: string }

const received: Received[] = []
const activity: Array<Record<string, unknown>> = []
const settings = new Map<string, string>()

let server: Server
let storeOrigin = ''

function keysIn(where: unknown): string[] | null {
  const key = (where as { key?: { in?: unknown } } | undefined)?.key
  const list = (key as { in?: unknown } | undefined)?.in
  return Array.isArray(list) ? list.map(String) : null
}

const dbMock = {
  setting: {
    findMany: async ({ where }: { where?: unknown } = {}) => {
      const wanted = keysIn(where)
      const rows = [...settings.entries()].map(([key, value]) => ({ key, value }))
      return wanted ? rows.filter((row) => wanted.includes(row.key)) : rows
    },
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = settings.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
    updateMany: async () => ({ count: 0 }),
  },
  shoppingOrderLink: {
    findFirst: async () => ({ externalOrderId: '4242' }),
  },
}

mock.module('@/lib/db', { namedExports: { db: dbMock } })

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (params: Record<string, unknown>) => { activity.push(params) },
    logActivityPersisted: async (params: Record<string, unknown>) => { activity.push(params); return true },
  },
})

/**
 * The real `connectorFetch` refuses plain http to loopback unless the E2E allowance is on, and
 * that allowance is not what is under test. This stub keeps the request REAL — it goes out over
 * TCP to the listener below — while leaving the SSRF layer out of the picture. It sits BELOW the
 * fence, so anything it records is a request the fence let through.
 */
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (input: string | URL, init: RequestInit = {}) => {
      const res = await fetch(String(input), {
        method: init.method ?? 'GET',
        headers: init.headers as HeadersInit | undefined,
        body: init.body as BodyInit | null | undefined,
      })
      return res
    },
  },
})

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 4242, ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  storeOrigin = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function reset(declared: string | undefined) {
  received.length = 0
  activity.length = 0
  settings.clear()
  if (declared === undefined) delete process.env.WC_WRITEBACK_ALLOWED_ORIGIN
  else process.env.WC_WRITEBACK_ALLOWED_ORIGIN = declared
}

function configureStore() {
  settings.set('wc_url', storeOrigin)
  settings.set('wc_consumer_key', 'ck_test')
  settings.set('wc_consumer_secret', 'cs_test')
  settings.set('wc_webhook_secret', 'whs_test')
  settings.set('wc_fx_push_enabled', 'true')
}

/** `validateWooCommerceBaseUrl` only accepts an http loopback store under the E2E allowance. */
const previousE2e = process.env.E2E_TEST_MODE
before(() => { process.env.E2E_TEST_MODE = '1' })
after(() => {
  if (previousE2e === undefined) delete process.env.E2E_TEST_MODE
  else process.env.E2E_TEST_MODE = previousE2e
})

function refusals() {
  return activity.filter((entry) => entry.tag === 'woocommerce-writeback-fence')
}

// ---------------------------------------------------------------------------
// The three-step reproduction: refuse → declare → change one character → refuse
// ---------------------------------------------------------------------------

test('step 1 of 3: an UNDECLARED installation refuses the order-status PUT, and says so in the activity log', async () => {
  reset(undefined)
  configureStore()

  const { wcPut } = await import('@/lib/connectors/woocommerce/api')
  const result = await wcPut('/orders/4242', { status: 'completed' })

  assert.equal(received.length, 0, 'the fence must refuse BEFORE anything reaches the store')
  assert.ok(result.error, 'the write must fail closed, not silently succeed')
  assert.match(result.error ?? '', /REFUSED/)
  assert.match(result.error ?? '', /WC_WRITEBACK_ALLOWED_ORIGIN/)

  const logged = refusals()
  assert.equal(logged.length, 1, 'exactly one loud, attributable refusal')
  assert.equal(logged[0].level, 'ERROR')
  assert.equal(logged[0].action, 'WOOCOMMERCE_WRITEBACK_REFUSED')
  const metadata = logged[0].metadata as Record<string, unknown>
  assert.equal(metadata.code, 'undeclared')
  assert.equal(metadata.attemptedOrigin, storeOrigin, 'the log names the origin that was attempted')
  assert.equal(metadata.declaredOrigin, null, 'and the origin that was declared — here, none')
  assert.equal(metadata.method, 'PUT')
})

test('step 2 of 3: declaring THAT origin lets the same write proceed, and the store really receives it', async () => {
  reset(storeOrigin)
  configureStore()

  const { wcPut } = await import('@/lib/connectors/woocommerce/api')
  const result = await wcPut('/orders/4242', { status: 'completed' })

  assert.equal(result.error, undefined, `expected the write to proceed, got: ${result.error}`)
  assert.equal(received.length, 1, 'exactly one request reached the declared store')
  assert.equal(received[0].method, 'PUT')
  assert.equal(received[0].url, '/wp-json/wc/v3/orders/4242')
  assert.deepEqual(JSON.parse(received[0].body), { status: 'completed' })
  assert.equal(refusals().length, 0, 'a permitted write logs no refusal')
})

test('step 3 of 3: changing the declared origin by ONE CHARACTER refuses it again', async () => {
  const lastDigit = storeOrigin.slice(-1)
  const bumped = storeOrigin.slice(0, -1) + (lastDigit === '9' ? '8' : String(Number(lastDigit) + 1))
  assert.notEqual(bumped, storeOrigin)
  assert.equal(bumped.length, storeOrigin.length)

  reset(bumped)
  configureStore()

  const { wcPut } = await import('@/lib/connectors/woocommerce/api')
  const result = await wcPut('/orders/4242', { status: 'completed' })

  assert.equal(received.length, 0, 'a one-character difference is a different store')
  assert.match(result.error ?? '', /REFUSED/)
  const logged = refusals()
  assert.equal(logged.length, 1)
  const metadata = logged[0].metadata as Record<string, unknown>
  assert.equal(metadata.code, 'origin_mismatch')
  assert.equal(metadata.declaredOrigin, bumped)
  assert.equal(metadata.attemptedOrigin, storeOrigin)
})

// ---------------------------------------------------------------------------
// Default-deny on a virgin state
// ---------------------------------------------------------------------------

test('default-deny: an EMPTY settings table refuses even a caller holding its own credentials', async () => {
  // The advisory-lock snapshot callers (stock-sync, product-sync) pass `creds` explicitly and
  // never go through getSettingValues, so "the settings table is empty" does not stop them. The
  // fence must, or a scratch database or restored backup could still write.
  reset(undefined)
  assert.equal(settings.size, 0, 'precondition: the settings table is empty')

  const { wcPut } = await import('@/lib/connectors/woocommerce/api')
  const result = await wcPut('/products/1', { stock_quantity: 5 }, {
    url: storeOrigin,
    key: 'ck_snapshot',
    secret: 'cs_snapshot',
  })

  assert.equal(received.length, 0)
  assert.match(result.error ?? '', /REFUSED/)
  assert.equal((refusals()[0]?.metadata as Record<string, unknown>).code, 'undeclared')
})

test('default-deny: the signed partial-shipment push — the duplicate-customer-email path — refuses when undeclared', async () => {
  reset(undefined)
  configureStore()

  const { pushPartialShipmentToWc } = await import('@/lib/connectors/woocommerce/sync/partial-shipment')
  const result = await pushPartialShipmentToWc('order-1', {
    part: 1,
    totalParts: 2,
    trackingNumber: 'TRK1',
    items: [{ sku: 'SKU-1', qty: 1 }],
  })

  assert.equal(received.length, 0, 'no partial-shipment row and no customer email at the store')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /REFUSED/)
  const metadata = refusals()[0].metadata as Record<string, unknown>
  assert.equal(metadata.purpose, 'partial-shipment push')
  assert.equal(metadata.attemptedOrigin, storeOrigin)
})

test('the partial-shipment push proceeds once the store is declared', async () => {
  reset(storeOrigin)
  configureStore()

  const { pushPartialShipmentToWc } = await import('@/lib/connectors/woocommerce/sync/partial-shipment')
  const result = await pushPartialShipmentToWc('order-1', {
    part: 1,
    totalParts: 2,
    trackingNumber: 'TRK1',
    items: [{ sku: 'SKU-1', qty: 1 }],
  })

  assert.equal(result.ok, true, result.error)
  assert.equal(received.length, 1)
  assert.equal(received[0].url, '/wp-json/oti/v1/order/4242/partial-shipment')
  assert.equal(refusals().length, 0)
})

// ---------------------------------------------------------------------------
// Reads are deliberately NOT fenced: the fence must not break the import path
// ---------------------------------------------------------------------------

test('a READ still works with no declaration, so an undeclared install is safe rather than useless', async () => {
  reset(undefined)
  configureStore()

  const { wcFetch } = await import('@/lib/connectors/woocommerce/api')
  const result = await wcFetch('/orders', { per_page: '1' })

  assert.equal(result.error, undefined, `expected the read to proceed, got: ${result.error}`)
  assert.equal(received.length, 1)
  assert.equal(received[0].method, 'GET')
  assert.equal(refusals().length, 0)
})
