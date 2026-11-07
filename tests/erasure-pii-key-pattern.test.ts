import assert from 'node:assert/strict'
import test from 'node:test'
import { scrubWmsMutationPayload } from '../lib/domain/wms/mutation-audit.ts'

/**
 * WHY THE RAW PAYLOAD SCRUB IS AN ALLOWLIST AND NOT scrubWmsMutationPayload: that redactor is KEY-NAME based, and the keys a WooCommerce order actually carries
 * (first_name, last_name, customer_note, the user agent, the order key, tracking numbers) are not among its patterns, and its containers (billing, shipping,
 * meta_data) are recursed into rather than masked. This pins the gap, so nobody "reuses the strongest PII primitive" for the raw stores later without seeing it.
 */
test('the key-name redactor lets WooCommerce identity keys through (so the raw-payload scrub uses an allowlist projection instead)', () => {
  const out = scrubWmsMutationPayload({
    billing: { first_name: 'Zebediah', last_name: 'Quillfeather', phone: '07700', country: 'GB' },
    customer_note: 'leave with Mrs Quillfeather', customer_user_agent: 'QuillBrowser', order_key: 'wc_order_KEY',
    meta_data: [{ key: 'gift_receiver_email', value: 'x@example.test' }],
  }) as { billing: Record<string, unknown>; customer_note: unknown; customer_user_agent: unknown; order_key: unknown }
  assert.equal(out.billing.first_name, 'Zebediah', 'first_name passes through')
  assert.equal(out.billing.last_name, 'Quillfeather', 'last_name passes through')
  assert.equal(out.customer_note, 'leave with Mrs Quillfeather')
  assert.equal(out.customer_user_agent, 'QuillBrowser')
  assert.equal(out.order_key, 'wc_order_KEY')
  assert.equal(out.billing.phone, '[masked]')
  assert.equal(out.billing.country, '[masked]', 'and it masks the country, which the tax evidence keeps')
})
