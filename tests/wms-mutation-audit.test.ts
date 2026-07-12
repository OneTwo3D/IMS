import assert from 'node:assert/strict'
import test from 'node:test'
import { scrubWmsMutationPayload } from '../lib/domain/wms/mutation-audit.ts'

test('scrub: PII-keyed values are masked, operational fields survive', () => {
  const scrubbed = scrubWmsMutationPayload({
    sku: 'ABC-1',
    quantity: 3,
    customerEmail: 'jane@example.com',
    shippingAddress: { line1: '1 High St' },
    phone: '07700 900000',
    vatNumber: 'GB123',
    courierService: 'DPD Next Day',
  }) as Record<string, unknown>
  assert.equal(scrubbed.sku, 'ABC-1')
  assert.equal(scrubbed.quantity, 3)
  assert.equal(scrubbed.customerEmail, '[masked]')
  assert.equal(scrubbed.shippingAddress, '[masked]')
  assert.equal(scrubbed.phone, '[masked]')
  assert.equal(scrubbed.vatNumber, '[masked]')
  assert.equal(scrubbed.courierService, 'DPD Next Day')
})

test('scrub: masking applies at any nesting depth', () => {
  const scrubbed = scrubWmsMutationPayload({
    intent: { lines: [{ sku: 'X', quantity: 1 }], email: 'a@b.c' },
  }) as { intent: { lines: Array<{ sku: string }>; email: string } }
  assert.equal(scrubbed.intent.email, '[masked]')
  assert.equal(scrubbed.intent.lines[0].sku, 'X')
})

test('scrub: depth, array, and string clamps prevent unbounded payloads', () => {
  // Depth clamp
  let deep: Record<string, unknown> = { v: 1 }
  for (let i = 0; i < 10; i += 1) deep = { nested: deep }
  const flattened = JSON.stringify(scrubWmsMutationPayload(deep))
  assert.match(flattened, /\[truncated\]/)

  // Array clamp
  const wide = scrubWmsMutationPayload(Array.from({ length: 500 }, (_, i) => i)) as unknown[]
  assert.equal(wide.length, 201)
  assert.equal(wide[200], '[+300 more]')

  // String clamp
  const long = scrubWmsMutationPayload('x'.repeat(5000)) as string
  assert.ok(long.length < 2100)
})

test('scrub: dates and decimal-like objects serialize to strings', () => {
  class FakeDecimal {
    constructor(private readonly value: string) {}
    toString() { return this.value }
  }
  const scrubbed = scrubWmsMutationPayload({
    at: new Date('2026-07-12T00:00:00Z'),
    qty: new FakeDecimal('12.5'),
  }) as Record<string, unknown>
  assert.equal(scrubbed.at, '2026-07-12T00:00:00.000Z')
  assert.equal(scrubbed.qty, '12.5')
})
