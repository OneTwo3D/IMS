import assert from 'node:assert/strict'
import test from 'node:test'

import { getRateLimitBackoffMs, isRateLimitError } from '../../lib/connectors/xero/deferral.ts'
import { OutboundWriteHeldError, outboundWriteRefusal } from '../../lib/security/outbound-write-grant.ts'
import { OUTBOUND_HELD_RETRY_DELAY_MS } from '../../lib/security/outbound-write-hold-constants.ts'

/**
 * A Xero posting refused by the outbound-write hold is handed back WITHOUT spending a retry, so a hold
 * that outlasts MAX_RETRIES never turns queued postings into FAILED rows. The text is produced by the
 * real refusal path, not typed here, so a change to the wording that breaks the recognition fails.
 */

function realHeldText(): string {
  const refusal = outboundWriteRefusal({ connectorName: 'Xero', method: 'POST', url: 'https://api.xero.com/api.xro/2.0/Invoices', headers: { 'Xero-Tenant-Id': 'x' }, env: {} })
  assert.ok(refusal, 'precondition: the real refusal path produced a refusal')
  return new OutboundWriteHeldError(refusal, 0).message
}

test('a held write defers without spending a retry, however it is wrapped, and waits the hold delay', () => {
  const text = realHeldText()
  console.log(`precondition (deferral): held text = "${text.slice(0, 60)}..."`)
  for (const wrapped of [text, `Contact error: ${text}`, `Failed to create invoice: ${text}`, `Error: ${text}`]) {
    assert.equal(isRateLimitError(wrapped), true, wrapped.slice(0, 40))
    assert.equal(getRateLimitBackoffMs(0, wrapped), OUTBOUND_HELD_RETRY_DELAY_MS)
    assert.equal(getRateLimitBackoffMs(4, wrapped), OUTBOUND_HELD_RETRY_DELAY_MS, 'not exponential')
  }
})

test('controls: an ordinary failure is NOT deferred, and a rate limit still is, with its own backoff', () => {
  for (const ordinary of ['Failed to create invoice', 'Xero 400: validation', 'Not connected to Xero', 'Contact error: boom']) {
    assert.equal(isRateLimitError(ordinary), false, ordinary)
  }
  assert.equal(isRateLimitError('Rate limited after retries; retry after 90000ms'), true)
  assert.equal(getRateLimitBackoffMs(0, 'Rate limited; retry after 120000ms'), 120_000)
  assert.equal(getRateLimitBackoffMs(2, 'status 429'), 240_000)
})

test('the processor uses these two functions at all four failure sites and defines no private copy', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const sites = (source.match(/if \(isRateLimitError\(errorMessage\)\)/g) ?? []).length
  console.log(`precondition (sites): ${sites} deferral decision sites in sync-processor.ts`)
  assert.equal(sites, 4, 'direct runner (returned and thrown) and outbox runner (returned and thrown)')
  assert.match(source, /import \{ getRateLimitBackoffMs, isRateLimitError \} from '\.\/deferral'/)
  assert.doesNotMatch(source, /function isRateLimitError|function getRateLimitBackoffMs/)
})

test('finding 4: a redirect-hop refusal is not deferred without spending a retry (it may have been applied)', () => {
  const refusal = outboundWriteRefusal({ connectorName: 'Xero', method: 'POST', url: 'https://api.xero.com/x', headers: { 'Xero-Tenant-Id': 'x' }, env: {} })
  assert.ok(refusal)
  const text = new OutboundWriteHeldError(refusal, 1).message
  console.log('precondition (xero finding 4): hop-1 text is not a held text')
  assert.equal(isRateLimitError(text), false)
  assert.equal(isRateLimitError(`Contact error: ${text}`), false)
})
