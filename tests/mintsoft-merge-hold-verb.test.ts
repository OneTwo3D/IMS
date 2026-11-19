import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test, { mock } from 'node:test'

/**
 * THE MERGE-HOLD VERB (o3d-zvec.12): GET /api/Order/{id}/MarkAwaitingConfirmation, against an in-memory fake. NO NETWORK: the Mintsoft client is replaced,
 * so no request of any kind (read, write or swagger) leaves this process. The real endpoint is verified only by the owner-approved controlled run in
 * docs/mintsoft.md.
 */

const CLIENT = 5
process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)

type Answer = { data?: unknown; error?: string; status: number; held?: boolean; redirectsFollowed?: number }
let details = new Map<string, unknown>()
let holdAnswer: Answer = { data: { Success: true }, status: 200 }
let calls: string[] = []

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({ mintsoft_client_id: String(CLIENT), mintsoft_courier_service_map: '', mintsoft_default_courier_service_id: '', mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}' }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    parseMintsoftPositiveId: (value: string | null | undefined): number | null => {
      const trimmed = (value ?? '').trim()
      return /^\d+$/.test(trimmed) && Number.parseInt(trimmed, 10) > 0 ? Number.parseInt(trimmed, 10) : null
    },
  },
})

mock.module('@/lib/connectors/mintsoft/api/client', {
  namedExports: {
    mintsoftRequest: async (path: string) => {
      calls.push(path)
      const pathname = path.split('?')[0]
      const detail = pathname.match(/^\/api\/Order\/([^/]+)$/)
      if (detail) {
        const id = decodeURIComponent(detail[1])
        return details.has(id) ? { data: details.get(id), status: 200 } : { data: null, status: 404 }
      }
      if (/^\/api\/Order\/[^/]+\/MarkAwaitingConfirmation$/.test(pathname)) return holdAnswer
      throw new Error(`Unexpected Mintsoft path: ${path}`)
    },
  },
})

const verb = () => import('@/lib/connectors/mintsoft/api/order-push')
const writes = () => calls.filter((path) => path.includes('/MarkAwaitingConfirmation'))

function reset() {
  details = new Map()
  holdAnswer = { data: { Success: true }, status: 200 }
  calls = []
}
const own = (over: Record<string, unknown> = {}) => ({ ID: 900, OrderNumber: 'WC-1001', OrderStatusId: 1, ClientId: CLIENT, ...over })

test('holdOrder: a NEW order of ours is held with exactly one MarkAwaitingConfirmation request', async () => {
  reset()
  const { holdMintsoftOrderForMerge } = await verb()
  details.set('900', own())
  assert.deepEqual(await holdMintsoftOrderForMerge('900', { expectedOrderNumber: 'WC-1001' }), { held: true, status: 'HELD' })
  assert.deepEqual(writes(), ['/api/Order/900/MarkAwaitingConfirmation'])
  assert.equal(calls.filter((p) => /Cancel|Comments|MarkConfirmed/.test(p)).length, 0, 'no cancel, comment or release request')
})

test('holdOrder: a FOREIGN order is refused by the ownership read and nothing is written', async () => {
  reset()
  const { holdMintsoftOrderForMerge } = await verb()
  details.set('999', own({ ID: 999, ClientId: 99 }))
  await assert.rejects(() => holdMintsoftOrderForMerge('999', { expectedOrderNumber: 'WC-1001' }), /does not match configured 5/)
  assert.deepEqual(writes(), [])
})

test('holdOrder: an order that cannot be proved to be this order is not held (mismatch and unverifiable)', async () => {
  reset()
  const { holdMintsoftOrderForMerge } = await verb()
  details.set('900', own({ OrderNumber: 'SOMETHING-ELSE' }))
  const mismatch = await holdMintsoftOrderForMerge('900', { expectedOrderNumber: 'WC-1001' })
  assert.equal(mismatch.held, false)
  assert.equal(mismatch.status, 'IDENTITY_MISMATCH')
  const unverifiable = await holdMintsoftOrderForMerge('900', { expectedOrderNumber: null })
  assert.equal(unverifiable.status, 'IDENTITY_UNVERIFIABLE')
  assert.deepEqual(writes(), [])
})

test('holdOrder: not found, already merged, cancelled and past NEW are each a distinct no-write answer', async () => {
  reset()
  const { holdMintsoftOrderForMerge } = await verb()
  assert.deepEqual(await holdMintsoftOrderForMerge('404', { expectedOrderNumber: 'WC-1001' }), { held: false, status: 'NOT_FOUND' })
  details.set('901', own({ ID: 901, OrderNumber: 'WC-1001+WC-1002' }))
  assert.equal((await holdMintsoftOrderForMerge('901', { expectedOrderNumber: 'WC-1001' })).held, false)
  details.set('902', own({ ID: 902, OrderStatusId: 3 }))
  assert.equal((await holdMintsoftOrderForMerge('902', { expectedOrderNumber: 'WC-1001' })).status, 'ALREADY_CANCELLED')
  details.set('903', own({ ID: 903, OrderStatusId: 4 }))
  assert.equal((await holdMintsoftOrderForMerge('903', { expectedOrderNumber: 'WC-1001' })).status, 'NOT_HOLDABLE')
  assert.deepEqual(writes(), [], 'none of these sent a hold')
})

test('holdOrder: a REFUSAL (Success false, or a direct 4xx) is returned, never thrown', async () => {
  reset()
  const { holdMintsoftOrderForMerge } = await verb()
  details.set('900', own())
  holdAnswer = { data: { Success: false, Message: 'Order not in a holdable state' }, status: 200 }
  assert.deepEqual(await holdMintsoftOrderForMerge('900', { expectedOrderNumber: 'WC-1001' }), { held: false, status: 'REFUSED', message: 'Order not in a holdable state' })
  holdAnswer = { data: null, error: 'Mintsoft 400: bad request', status: 400, redirectsFollowed: 0 }
  const direct = await holdMintsoftOrderForMerge('900', { expectedOrderNumber: 'WC-1001' })
  assert.equal(direct.status, 'REFUSED')
})

test('holdOrder: a TRANSPORT failure THROWS and is never reported as a refusal or a hold', async () => {
  reset()
  const { holdMintsoftOrderForMerge } = await verb()
  details.set('900', own())
  const failures: Answer[] = [
    { data: null, error: 'Mintsoft 500', status: 500 },
    { data: null, error: 'timeout', status: 408, redirectsFollowed: 0 },
    { data: null, error: 'Mintsoft 400 after a redirect', status: 400, redirectsFollowed: 1 },
    { data: null, error: 'outbound write held', status: 500, held: true },
    { data: { Message: 'no verdict' }, status: 200 },
    { data: null, status: 204 },
  ]
  for (const failure of failures) {
    holdAnswer = failure
    await assert.rejects(() => holdMintsoftOrderForMerge('900', { expectedOrderNumber: 'WC-1001' }), Error, JSON.stringify(failure))
  }
})

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return entry === 'generated' ? [] : sources(full)
    return /\.(ts|tsx)$/.test(full) ? [full] : []
  })
}

test('there is NO release path: nothing in lib/ or app/ names MarkConfirmed or a release verb on the connector', () => {
  const hits: string[] = []
  for (const root of ['lib', 'app']) {
    for (const file of sources(join(process.cwd(), root))) {
      const text = readFileSync(file, 'utf8')
      if (/MarkConfirmed/.test(text) || /\breleaseOrder\b/.test(text) || /\bconfirmOrder\b/.test(text)) hits.push(file)
    }
  }
  assert.deepEqual(hits, [])
})
