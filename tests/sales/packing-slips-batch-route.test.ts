import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

// The batch packing-slip route prints ONLY the selected orders, through the shared renderer.

let role = 'ADMIN'
mock.module('@/lib/auth/server', {
  namedExports: {
    requireApiAuth: async () => ({ user: { id: 'u1', role } }),
  },
})

const statusQueries: string[][] = []
const loaded: string[] = []
const drawn: string[] = []
const known = new Map([
  ['a', 'PROCESSING'], ['b', 'SHIPPED'], ['c', 'CANCELLED'], ['d', 'DRAFT'], ['other', 'PROCESSING'],
])
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async (args: { where: { id: { in: string[] } } }) => {
          statusQueries.push(args.where.id.in)
          return args.where.id.in.filter((id) => known.has(id)).map((id) => ({ id, status: known.get(id), orderNumber: `SO-${id}`, externalOrderNumber: null }))
        },
      },
    },
  },
})
mock.module('@/lib/sales/packing-slip-document', {
  namedExports: {
    loadPackingSlipContext: async () => ({ branding: {}, tpl: null, tz: 'UTC' }),
    loadPackingSlipOrder: async (id: string) => { loaded.push(id); return { ok: true, data: { so: { id }, shipments: [] } } },
    drawPackingSlip: async (doc: { font: (n: string) => { text: (t: string) => void } }, data: { so: { id: string } }) => { drawn.push(data.so.id); doc.font('Helvetica').text(`slip ${data.so.id}`) },
  },
})

beforeEach(() => { role = 'ADMIN'; statusQueries.length = 0; loaded.length = 0; drawn.length = 0 })

const call = async (ids: string) => {
  const { GET } = await import('@/app/api/packing-slips/route')
  return GET(new Request(`http://localhost/api/packing-slips?ids=${ids}`))
}

test('prints a PDF of exactly the selected, printable orders and nothing else', async () => {
  const res = await call('a,b,c,d')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/pdf')
  const bytes = new Uint8Array(await res.arrayBuffer())
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-')
  assert.deepEqual(statusQueries, [['a', 'b', 'c', 'd']], 'only the named ids are queried')
  assert.deepEqual(loaded, ['a', 'b'], 'cancelled and draft orders are not rendered; unselected orders never are')
  assert.deepEqual(drawn, ['a', 'b'])
  assert.ok(!loaded.includes('other'))
})

test('refuses when no selected order can have a slip, and enforces the cap and the permission', async () => {
  assert.equal((await call('c,d')).status, 409)
  assert.equal((await call('')).status, 400)
  assert.equal((await call(Array.from({ length: 101 }, (_, i) => `i${i}`).join(','))).status, 400)
  role = 'SUPPLIER'
  assert.equal((await call('a')).status, 403)
})
