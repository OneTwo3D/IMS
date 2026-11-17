import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { NextResponse } from 'next/server'

/**
 * THE GATES OF THE ORDER-ATTACHMENT ROUTES, with the database and the session doubled (no network, a temp dir for files): authentication first (401),
 * then the permission for that order type (403), only then a lookup, and the lookup is by (order id, attachment id). The database behaviour (cross-order,
 * soft delete, erasure) is proved against a real database in tests/concurrency/order-attachments.concurrent.test.ts.
 */
const privateRoot = mkdtempSync(path.join(os.tmpdir(), 'oa-auth-'))
process.env.UPLOAD_STORAGE_DIR = privateRoot

type Session = { user: { id: string; role: string } } | NextResponse
let session: Session = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const calls: string[] = []
const stored = new Map<string, { storedName: string; originalFilename: string; mimeType: string; byteSize: number }>()

mock.module('@/lib/auth/server', { namedExports: { requireApiAuth: async () => session } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/db', { namedExports: { db: new Proxy({}, { get() { throw new Error('the database must not be reached by this test') } }) } })

let routes: typeof import('../../lib/order-attachment-routes.ts')
test.before(async () => {
  const actualDomain = await import('../../lib/domain/order-attachments/index.ts')
  mock.module('@/lib/domain/order-attachments', {
    namedExports: {
      ...actualDomain,
      createOrderAttachment: async () => { calls.push('create'); return { ok: true, id: 'att-1' } },
      findOrderAttachment: async (kind: string, orderId: string, id: string) => { calls.push(`find:${kind}:${orderId}:${id}`); return stored.get(`${kind}:${orderId}:${id}`) ?? null },
      softDeleteOrderAttachment: async (kind: string, orderId: string, id: string) => { calls.push(`delete:${kind}:${orderId}:${id}`); return stored.has(`${kind}:${orderId}:${id}`) ? { storedName: 'x', mimeType: 'application/pdf', byteSize: 1 } : null },
    },
  })
  routes = await import('../../lib/order-attachment-routes.ts')
})
const handleUpload: typeof import('../../lib/order-attachment-routes.ts').handleUpload = (...args) => routes.handleUpload(...args)
const handleDownload: typeof import('../../lib/order-attachment-routes.ts').handleDownload = (...args) => routes.handleDownload(...args)
const handleDelete: typeof import('../../lib/order-attachment-routes.ts').handleDelete = (...args) => routes.handleDelete(...args)

const PDF = Buffer.from('%PDF-1.4\nbody\n%%EOF\n', 'latin1')
const as = (role: string): Session => ({ user: { id: `${role}-user`, role } })
function uploadRequest(bytes: Buffer = PDF, name = 'quote.pdf'): Request {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }))
  return new Request('http://localhost/api/order-attachments/x', { method: 'POST', body: form })
}
const get = () => new Request('http://localhost/x')

test.beforeEach(() => { calls.length = 0; stored.clear(); session = NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
test.after(() => rmSync(privateRoot, { recursive: true, force: true }))

test('no session: upload, download and delete answer 401 and reach nothing', async () => {
  for (const kind of ['purchase-orders', 'sales-orders']) {
    assert.equal((await handleUpload(uploadRequest(), { kind, orderId: 'o1' })).status, 401)
    assert.equal((await handleDownload(get(), { kind, orderId: 'o1', id: 'a1' })).status, 401)
    assert.equal((await handleDelete(get(), { kind, orderId: 'o1', id: 'a1' })).status, 401)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(readdirSync(privateRoot), [], 'no file was written')
})

test('an unknown order type is 404 and the id never reaches a lookup', async () => {
  session = as('ADMIN')
  assert.equal((await handleDownload(get(), { kind: 'products', orderId: 'o1', id: 'a1' })).status, 404)
  assert.equal((await handleUpload(uploadRequest(), { kind: '../etc', orderId: 'o1' })).status, 404)
  assert.deepEqual(calls, [])
})

// role -> [view, edit] per order type, from the existing permission keys (purchasing / purchasing.create|receive, sales / sales.create|process).
const MATRIX: Array<{ role: string; purchase: [boolean, boolean]; sales: [boolean, boolean] }> = [
  { role: 'ADMIN', purchase: [true, true], sales: [true, true] },
  { role: 'MANAGER', purchase: [true, true], sales: [true, true] },
  { role: 'WAREHOUSE', purchase: [true, true], sales: [true, true] }, // receive / process
  { role: 'FINANCE', purchase: [true, true], sales: [true, false] }, // purchasing.create; sales has refund only
  { role: 'READONLY', purchase: [true, false], sales: [true, false] },
  { role: 'SUPPLIER', purchase: [false, false], sales: [false, false] }, // an external principal: no internal key
]

test('permission matrix: view gates download, edit gates upload and delete, per order type; a denied request never reaches the lookup or the disk', async () => {
  for (const { role, purchase, sales } of MATRIX) {
    for (const [kind, key, [canView, canEdit]] of [['purchase-orders', 'purchase', purchase], ['sales-orders', 'sales', sales]] as const) {
      session = as(role)
      stored.set(`${key}:o1:a1`, { storedName: 'x', originalFilename: 'q.pdf', mimeType: 'application/pdf', byteSize: 1 })
      calls.length = 0
      const before = readdirSync(privateRoot).length
      const up = await handleUpload(uploadRequest(), { kind, orderId: 'o1' })
      assert.equal(up.status, canEdit ? 201 : 403, `${role} upload ${kind}`)
      if (!canEdit) assert.equal(readdirSync(privateRoot).length, before, `${role} ${kind}: a denied upload writes nothing`)
      const del = await handleDelete(get(), { kind, orderId: 'o1', id: 'a1' })
      assert.equal(del.status, canEdit ? 200 : 403, `${role} delete ${kind}`)
      const dl = await handleDownload(get(), { kind, orderId: 'o1', id: 'a1' })
      // The stored name 'x' is not a server-generated name, so an allowed download ends in 404 (no file), never 403: that is the gate order under test.
      assert.equal(dl.status, canView ? 404 : 403, `${role} download ${kind}`)
      if (!canView) assert.ok(!calls.some((c) => c.startsWith('find:')), `${role} ${kind}: no lookup for a denied download`)
      if (!canEdit) assert.ok(!calls.some((c) => c === 'create' || c.startsWith('delete:')), `${role} ${kind}: no write for a denied edit`)
    }
  }
})

test('download: an attachment with nosniff, no-store and the verified type, found by (order, id); a forged stored name cannot leave the directory', async () => {
  session = as('READONLY')
  mkdirSync(path.join(privateRoot, 'order-attachments'), { recursive: true })
  const storedName = '0b7f3f5e-1c2d-4e8a-9b6c-1234567890ab.pdf'
  writeFileSync(path.join(privateRoot, 'order-attachments', storedName), PDF)
  stored.set('purchase:o1:a1', { storedName, originalFilename: 'Quote "final".pdf', mimeType: 'application/pdf', byteSize: PDF.length })
  const ok = await handleDownload(get(), { kind: 'purchase-orders', orderId: 'o1', id: 'a1' })
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-disposition') ?? '', /^attachment; filename="Quote _final_\.pdf"/)
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(ok.headers.get('content-type'), 'application/pdf')
  assert.match(ok.headers.get('cache-control') ?? '', /no-store/)
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PDF)

  // The same id asked under another order, or another order type, is not found.
  assert.equal((await handleDownload(get(), { kind: 'purchase-orders', orderId: 'o2', id: 'a1' })).status, 404)
  assert.equal((await handleDownload(get(), { kind: 'sales-orders', orderId: 'o1', id: 'a1' })).status, 404)

  // A row that somehow names a path outside the directory resolves to nothing.
  for (const forged of ['../../etc/passwd', '../order-attachments/' + storedName, `${storedName}/../${storedName}`, '/etc/passwd', 'a.pdf']) {
    stored.set('purchase:o1:forged', { storedName: forged, originalFilename: 'x.pdf', mimeType: 'application/pdf', byteSize: 1 })
    assert.equal((await handleDownload(get(), { kind: 'purchase-orders', orderId: 'o1', id: 'forged' })).status, 404, forged)
  }
})

test('upload: an oversize Content-Length is refused before the body is read', async () => {
  session = as('ADMIN')
  const req = new Request('http://localhost/x', { method: 'POST', headers: { 'content-length': String(60 * 1024 * 1024) }, body: new FormData() })
  const res = await handleUpload(req, { kind: 'purchase-orders', orderId: 'o1' })
  assert.equal(res.status, 413)
  assert.deepEqual(calls, [])
})

test('upload: a spoofed or disallowed file is refused with 400 and writes nothing', async () => {
  session = as('ADMIN')
  const before = readdirSync(privateRoot)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
  assert.equal((await handleUpload(uploadRequest(png, 'quote.pdf'), { kind: 'purchase-orders', orderId: 'o1' })).status, 400, 'a PNG named .pdf')
  assert.equal((await handleUpload(uploadRequest(PDF, 'tool.exe'), { kind: 'purchase-orders', orderId: 'o1' })).status, 400, 'a disallowed extension')
  assert.equal((await handleUpload(uploadRequest(Buffer.alloc(0), 'empty.pdf'), { kind: 'purchase-orders', orderId: 'o1' })).status, 400, 'an empty file')
  const big = Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)])
  assert.equal((await handleUpload(uploadRequest(big, 'big.pdf'), { kind: 'purchase-orders', orderId: 'o1' })).status, 413, 'over the existing upload limit')
  assert.deepEqual(readdirSync(privateRoot), before, 'nothing was stored')
  assert.ok(!calls.includes('create'), 'no row was created')
})

test('upload: the size cap is enforced WHILE STREAMING: a body with no Content-Length is cut off near the cap, not buffered whole', async () => {
  session = as('ADMIN')
  const CHUNK = 1024 * 1024
  const TOTAL_CHUNKS = 200 // a 200 MB body, far past the 20 MB cap
  let pulled = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= TOTAL_CHUNKS) { controller.close(); return }
      pulled += 1
      controller.enqueue(new Uint8Array(CHUNK))
    },
    cancel() { cancelled = true },
  })
  const req = new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: stream, duplex: 'half' } as RequestInit)
  assert.equal(req.headers.get('content-length'), null, 'PRECONDITION: no declared length to trust')
  const res = await handleUpload(req, { kind: 'purchase-orders', orderId: 'o1' })
  assert.equal(res.status, 413)
  assert.ok(cancelled, 'the sender was cancelled')
  assert.ok(pulled <= 26, `read ${pulled} MB of a 200 MB body: stopped near the cap`)
  assert.ok(!calls.includes('create'))
  // CONTROL: the same reader accepts a body under the cap.
  const { readBodyCapped } = await import('../../lib/order-attachment-routes.ts')
  assert.equal((await readBodyCapped(new Request('http://localhost/x', { method: 'POST', body: new Uint8Array(1000) }), 2000))?.length, 1000)
  assert.equal(await readBodyCapped(new Request('http://localhost/x', { method: 'POST', body: new Uint8Array(3000) }), 2000), null)
})
