import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { mock } from 'node:test'
import { PROBE_ROWS } from './helpers/mintsoft-stock-probe-rows.ts'
import { normalizeMintsoftStockLevels, normalizeMintsoftStockLine } from '../lib/connectors/mintsoft/api/normalizers.ts'
import { consolidateMintsoftStockLines } from '../lib/connectors/mintsoft/sync/stock-sync-helpers.ts'

/**
 * o3d-4pzls: Mintsoft StockLevels carries Level (AVAILABLE) and TotalStockLevel (ON HAND). IMS
 * stock_levels.quantity is on hand, so every consumer must read TotalStockLevel. Rows are copied
 * from the live probe; no network call is made (the client arm talks to a loopback double).
 */

let baseUrl = ''
let responseBody: unknown = []
mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => ({
      baseUrl, authMode: 'credentials', staticApiKey: '', username: 'u', password: 'p', webhookSecret: '', clientId: '89', orderLookupConnector: null,
    }),
    getMintsoftAccessToken: async () => 'k',
    invalidateMintsoftAccessToken: async () => undefined,
  },
})
mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_client_id: '89', mintsoft_courier_service_map: '', mintsoft_default_courier_service_id: '',
      mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}',
    }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    parseMintsoftPositiveId: (value: string | null | undefined): number | null => {
      const trimmed = (value ?? '').trim()
      return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : null
    },
  },
})

const row = (over: Record<string, unknown>) => ({ ...PROBE_ROWS[0], ...over })
function without(field: string) {
  const copy: Record<string, unknown> = { ...PROBE_ROWS[0] }
  delete copy[field]
  return copy
}

test('probe-shaped rows: onHand is TotalStockLevel and available is Level, never swapped', () => {
  const lines = normalizeMintsoftStockLevels(PROBE_ROWS)
  assert.deepEqual(lines.map((l) => [l.sku, l.onHand, l.available]), [
    ['129552751', 36, 28], ['41352158742', 200, 199], ['54524161462-01', 3, 1], ['22771122402-02', 0, 0], ['75641124454', 16, 8],
  ])
  assert.deepEqual(lines[0].raw, PROBE_ROWS[0], 'the raw payload (stored on discrepancy rows) keeps both fields')
})

test('Level alone is NOT enough: no TotalStockLevel fails closed, never falls back to Level or 0', () => {
  assert.throws(() => normalizeMintsoftStockLine(without('TotalStockLevel')), /TotalStockLevel \(on hand\) is missing/)
  assert.throws(() => normalizeMintsoftStockLine({ SKU: 'X', Level: 5 }), /TotalStockLevel \(on hand\) is missing/)
  assert.throws(() => normalizeMintsoftStockLevels([PROBE_ROWS[1], without('TotalStockLevel')]), /row 1 .*TotalStockLevel/)
})

test('legacy / look-alike field names are NOT accepted as on hand', () => {
  for (const name of ['totalStockLevel', 'Quantity', 'FreeStock', 'StockLevel', 'level']) {
    const r: Record<string, unknown> = { SKU: 'X', Level: 5, [name]: 9 }
    assert.throws(() => normalizeMintsoftStockLine(r), /TotalStockLevel \(on hand\) is missing/, name)
  }
  assert.throws(() => normalizeMintsoftStockLine({ sku: 'X', TotalStockLevel: 5 }), /SKU must be a non-empty string/)
})

test('TotalStockLevel must be a non-negative integer NUMBER: null, string, negative, fractional, NaN, Infinity all throw', () => {
  for (const bad of [null, '36', '', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
    assert.throws(() => normalizeMintsoftStockLine(row({ TotalStockLevel: bad })), /TotalStockLevel must be a non-negative integer/, String(bad))
  }
})

test('a present-but-malformed Level also throws (schema drift), and Level above TotalStockLevel throws (fields swapped)', () => {
  for (const bad of [null, '28', -3, 2.5]) {
    assert.throws(() => normalizeMintsoftStockLine(row({ Level: bad })), /Level must be a non-negative integer/, String(bad))
  }
  assert.throws(() => normalizeMintsoftStockLine(row({ Level: 40, TotalStockLevel: 36 })), /exceeds TotalStockLevel/)
})

test('Level absent (but TotalStockLevel present) is readable: available is null, onHand still exact', () => {
  assert.deepEqual(
    (({ onHand, available }) => ({ onHand, available }))(normalizeMintsoftStockLine(without('Level'))),
    { onHand: 36, available: null },
  )
})

test('unreadable SKU or row shape throws instead of being dropped', () => {
  for (const bad of [null, 'x', 7, [], { TotalStockLevel: 1 }, row({ SKU: '' }), row({ SKU: '   ' }), row({ SKU: 129552751 }), row({ SKU: null })]) {
    assert.throws(() => normalizeMintsoftStockLine(bad), /Mintsoft StockLevels row/)
  }
})

test('a duplicate SKU in one response fails the whole response (no merge, no first/last wins)', () => {
  assert.throws(() => normalizeMintsoftStockLevels([PROBE_ROWS[0], PROBE_ROWS[1], row({ Level: 1, TotalStockLevel: 2 })]), /duplicate SKU "129552751"/)
  assert.throws(() => consolidateMintsoftStockLines([
    { sku: 'ABC', onHand: 2, available: 2, raw: null },
    { sku: 'ABC', onHand: 3, available: 3, raw: null },
  ]), /appears more than once/)
})

test('a malformed response body (not an array) fails closed rather than reading as an empty warehouse', () => {
  for (const bad of [null, 'oops', 5, { error: 'x' }]) {
    assert.throws(() => normalizeMintsoftStockLevels(bad), /StockLevels: expected an array/)
  }
  assert.deepEqual(normalizeMintsoftStockLevels([]), [])
})

test('consolidateMintsoftStockLines sorts by SKU and keeps both quantities', () => {
  assert.deepEqual(consolidateMintsoftStockLines([
    { sku: 'B', onHand: 5, available: 4, raw: null },
    { sku: 'A', onHand: 1, available: null, raw: { a: 1 } },
  ]), [
    { sku: 'A', onHand: 1, available: null, raw: { a: 1 } },
    { sku: 'B', onHand: 5, available: 4, raw: null },
  ])
})

test('fetchMintsoftStockLevels (real client, loopback double): returns on-hand from TotalStockLevel and fails closed on a bad body', async () => {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(responseBody))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1' // lets the client accept the loopback http URL
  try {
    const { fetchMintsoftStockLevels } = await import('../lib/connectors/mintsoft/api/client')
    responseBody = PROBE_ROWS
    const lines = await fetchMintsoftStockLevels('6')
    assert.deepEqual(seen, ['GET /api/Product/StockLevels?WarehouseId=6'])
    assert.deepEqual(lines.map((l) => [l.sku, l.onHand, l.available]), [
      ['129552751', 36, 28], ['41352158742', 200, 199], ['54524161462-01', 3, 1], ['22771122402-02', 0, 0], ['75641124454', 16, 8],
    ])
    responseBody = [PROBE_ROWS[0], without('TotalStockLevel')]
    await assert.rejects(fetchMintsoftStockLevels('6'), /row 1 .*TotalStockLevel \(on hand\) is missing/)
    responseBody = [PROBE_ROWS[0], PROBE_ROWS[0]]
    await assert.rejects(fetchMintsoftStockLevels('6'), /duplicate SKU/)
  } finally {
    delete process.env.E2E_TEST_MODE
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
