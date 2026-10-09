import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * THE DIRECT XERO WRITE (generateMissingXeroTaxRates) ASKS THE PRODUCER-SIDE HOLD BEFORE IT CALLS XERO.
 *
 * `xeroTaxRateWriteShadow` is the whole of the question the action asks (the action file can export only async
 * functions, so the seam lives in lib/). Null means go ahead; a notice means nothing was sent. The census
 * (tests/scripts/producer-census.test.ts, SEAM-1) holds the action to calling it BEFORE putXeroTaxRate.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  proceed-on-shadow   the helper returns null for a shadow: the notice arms go red
 *  b  record-throws       a failed shadow record escapes: the lost-evidence arm goes red
 *  c  legacy-enforces     the helper ignores the switch: the switch-off arm goes red
 */

const upserts: Array<{ text: string; values: unknown[] }> = []
let failUpserts = false

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $queryRaw: async (query: { strings?: readonly string[]; values?: unknown[] }) => {
        upserts.push({ text: (query.strings ?? []).join('?'), values: query.values ?? [] })
        if (failUpserts) throw new Error('shadow table unavailable')
        return [{ id: 'shadow-1', inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
      },
    },
  },
})

const KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM']
const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'

async function ask(env: Record<string, string>) {
  const saved = KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of KEYS) delete process.env[key]
  Object.assign(process.env, env)
  upserts.length = 0
  try {
    const { xeroTaxRateWriteShadow } = await import('@/lib/domain/accounting/xero-direct-write-seam')
    return await xeroTaxRateWriteShadow({ taxRateIds: ['b', 'a'], reportTypeOverrides: { a: 'OUTPUT' } })
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

test('switch OFF: the action goes ahead and nothing is recorded (the pre-seam behaviour)', async () => {
  failUpserts = false
  const answer = await ask({})
  console.log(`# switch off: ${JSON.stringify(answer)} shadow records=${upserts.length}`)
  assert.equal(answer, null)
  assert.equal(upserts.length, 0)
})

test('switch ON, nothing granted: the action is refused with the single-sourced notice naming the operator as owner, and the shadow is recorded once', async () => {
  failUpserts = false
  const answer = await ask({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' })
  console.log(`# switch on, ungranted: ${JSON.stringify(answer)} shadow records=${upserts.length}`)
  assert.ok(answer)
  assert.match(answer.notice, /^Not sent by IMS: writes to Xero are held on this installation/)
  assert.match(answer.notice, /Owner of this operation in the current phase: an operator working by hand/)
  assert.equal(upserts.length, 1, 'PRECONDITION: the shadow record was attempted')
  assert.ok(upserts[0]!.values.includes('tax-rate'))
  assert.ok(upserts[0]!.values.includes('xero'))
  assert.ok(upserts[0]!.values.includes('a,b'), 'the ids are sorted, so the same confirmation is the same work')
})

test('switch ON and FULLY granted: still refused. Xero is the master for tax rates, so no component is the writer in any phase', async () => {
  failUpserts = false
  const answer = await ask({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: '2020-01-01T00:00:00Z' })
  assert.ok(answer)
  assert.match(answer.notice, /another writer owns this operation in the current phase/)
  assert.match(answer.notice, /Owner of this operation in the current phase: no writer/)
})

test('LOST EVIDENCE IS NEVER A THROWN ACTION: a failed shadow record still returns the refusal', async () => {
  failUpserts = true
  const originalError = console.error
  console.error = () => undefined
  try {
    const answer = await ask({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' })
    assert.ok(answer)
    assert.equal(upserts.length, 1, 'PRECONDITION: the record was attempted and failed')
  } finally { console.error = originalError; failUpserts = false }
})

test('STRUCTURAL: generateMissingXeroTaxRates returns the refusal BEFORE it fetches rates or calls putXeroTaxRate (the census proves the call is there and ordered; this proves its answer is acted on)', () => {
  const source = readFileSync('app/actions/settings.ts', 'utf8')
  const start = source.indexOf('export async function generateMissingXeroTaxRates')
  assert.ok(start > 0, 'PRECONDITION: the action was found')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  const ask = body.indexOf('xeroTaxRateWriteShadow(')
  const refuse = body.indexOf('if (shadow) return')
  const fetch = body.indexOf('getXeroTaxRates()')
  const write = body.indexOf('putXeroTaxRate(')
  console.log(`# action offsets: ask=${ask} refuse=${refuse} fetch=${fetch} write=${write}`)
  assert.ok(ask > 0 && refuse > ask && fetch > refuse && write > refuse, 'ask, then refuse, then fetch and write')
  assert.match(body.slice(refuse, refuse + 200), /error: shadow\.notice/, 'the refusal carries the single-sourced notice')
})
