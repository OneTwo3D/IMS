import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import {
  CSV_EXPORT_METADATA_MAX_JSON_BYTES,
  CSV_EXPORT_NOTICES_HEADER,
  CSV_EXPORT_NOTICES_TRUNCATED_HEADER,
  csvResponseWithNotices,
  parseCsv,
  toCsv,
} from '@/lib/csv'

const csv = toCsv([{ sku: 'SKU-1', qty: '1' }], ['sku', 'qty'])
const decode = (response: Response): string[] =>
  JSON.parse(Buffer.from(response.headers.get(CSV_EXPORT_NOTICES_HEADER) ?? '', 'base64url').toString('utf8')) as string[]

test('report notices ride in a response header and leave the body as data rows only', async () => {
  const notices = ['No claimed recipe: component demand not planned for 1 BOM product(s): BOM-1.']
  const response = csvResponseWithNotices(csv, 'x.csv', notices)
  const body = await response.text()
  assert.equal(body, csv, 'no # rows by default')
  assert.deepEqual(decode(response), notices)
  assert.equal(response.headers.get(CSV_EXPORT_NOTICES_TRUNCATED_HEADER), null)
  assert.match(response.headers.get('Access-Control-Expose-Headers') ?? '', new RegExp(CSV_EXPORT_NOTICES_HEADER))
})

test('opting in appends the notices after the data as # rows, and the data still parses', async () => {
  const notices = ['1 started order(s) have no usable frozen recipe: MO-1.']
  const response = csvResponseWithNotices(csv, 'x.csv', notices, { includeInBody: true })
  const body = await response.text()
  assert.deepEqual(parseCsv(body), [{ sku: 'SKU-1', qty: '1' }])
  assert.match(body, /\r\n# IMS export metadata\r\n/)
  assert.match(body, /MO-1/)
  assert.deepEqual(decode(response), notices)
})

test('no notices: no header and no rows, whatever the opt-in', async () => {
  for (const includeInBody of [false, true]) {
    const response = csvResponseWithNotices(csv, 'x.csv', [], { includeInBody })
    assert.equal(await response.text(), csv)
    assert.equal(response.headers.get(CSV_EXPORT_NOTICES_HEADER), null)
  }
})

test('notices past the header cap are cut from the end and flagged', () => {
  const notices = Array.from({ length: 40 }, (_, i) => `${i}:${'x'.repeat(300)}`)
  const response = csvResponseWithNotices(csv, 'x.csv', notices)
  const kept = decode(response)
  assert.ok(kept.length > 0 && kept.length < notices.length)
  assert.deepEqual(kept, notices.slice(0, kept.length))
  assert.ok(Buffer.byteLength(JSON.stringify(kept), 'utf8') <= CSV_EXPORT_METADATA_MAX_JSON_BYTES)
  assert.equal(response.headers.get(CSV_EXPORT_NOTICES_TRUNCATED_HEADER), 'true')
})
