import assert from 'node:assert/strict'
import test from 'node:test'


/**
 * THE HOLD REFERENCE IS STABLE ACROSS PROCESSES AND STILL UNFORGEABLE BY VENDOR TEXT.
 *
 * A hold text is persisted (outbox lastError, sync-log rows, link errors) and read back by ANOTHER process
 * or after a restart; a reference that differed per process would make that text unrecognisable and bring
 * back the attempt-spending and dead-lettering the hold exists to prevent. The reference is an HMAC keyed by
 * SETTINGS_ENCRYPTION_KEY, so every process of an installation agrees, and a vendor cannot compute it.
 *
 * A "process" is modelled as a FRESH MODULE INSTANCE (a distinct import URL), which has none of the first
 * instance's memory: a stored per-process secret could not survive that, a key-derived reference does.
 */

import { spawnSync } from 'node:child_process'

const KEY_A = 'a1'.repeat(32) // 64 hex chars: a valid 32-byte key
const KEY_B = 'b2'.repeat(32)
const REPO_ROOT = process.cwd()

/** Run `code` in a REAL separate Node process whose only shared state is the environment passed in. */
function inProcess(key: string | null, data: Record<string, unknown>, code: string): { out: Record<string, unknown>; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1', HOLD_TEST_DATA: JSON.stringify(data) }
  delete env.ENCRYPTION_KEY
  if (key === null) delete env.SETTINGS_ENCRYPTION_KEY
  else env.SETTINGS_ENCRYPTION_KEY = key
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--experimental-test-module-mocks', '-e', code], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  assert.equal(child.status, 0, `child failed:\n${child.stderr}`)
  return { out: JSON.parse(child.stdout.trim().split('\n').pop()!) as Record<string, unknown>, stderr: child.stderr }
}

const WRITE = `
  const { OutboundWriteHeldError } = await import('@/lib/security/outbound-write-grant')
  const c = await import('@/lib/security/outbound-write-hold-constants')
  const k = c.isOutboundWriteHeldText ? c : c.default
  const g = await import('@/lib/security/outbound-write-grant'); const G = g.OutboundWriteHeldError ? g : g.default
  const refusal = { connector: 'woocommerce', code: 'no_grant', method: 'PUT', target: 'https://shop.example.com/x', granted: null, attempted: null, basis: 'b' }
  const held = new G.OutboundWriteHeldError(refusal, 0).message
  console.log(JSON.stringify({ held, maybe: k.outboundTextAfterEarlierSend(held, 'WooCommerce') }))
  process.exit(0)
`

const READ = `
  const c = await import('@/lib/security/outbound-write-hold-constants'); const k = c.isOutboundWriteHeldText ? c : c.default
  const d = JSON.parse(process.env.HOLD_TEST_DATA)
  const r = {}
  for (const [name, text] of Object.entries(d.texts)) r[name] = { held: k.isOutboundWriteHeldText(text), maybe: k.isOutboundMaybeSentRefusalText(text) }
  console.log(JSON.stringify(r))
  process.exit(0)
`

test('a hold text written by one PROCESS is recognised by another with the same key, and by neither with a different key or none', () => {
  const { out: written } = inProcess(KEY_A, {}, WRITE)
  const texts = { held: written.held, maybe: written.maybe }
  console.log('precondition (stable reference): two real processes; #1 writes a held text and a maybe-sent text, #2 reads them')
  const sameKey = inProcess(KEY_A, { texts }, READ).out as Record<string, { held: boolean; maybe: boolean }>
  assert.deepEqual(sameKey.held, { held: true, maybe: false }, 'process #2 recognises process #1 hold text')
  assert.deepEqual(sameKey.maybe, { held: false, maybe: true }, 'and the references are per kind')
  const otherKey = inProcess(KEY_B, { texts }, READ).out as Record<string, { held: boolean; maybe: boolean }>
  assert.deepEqual(otherKey.held, { held: false, maybe: false }, 'a different installation key recognises nothing')
  assert.deepEqual(otherKey.maybe, { held: false, maybe: false })
  const noKey = inProcess(null, { texts }, READ).out as Record<string, { held: boolean; maybe: boolean }>
  assert.deepEqual(noKey.held, { held: false, maybe: false }, 'no key: nothing is recognised, and nothing throws')
})

test('persisted and re-read through the REAL outbox in another process: a held text stays a hold (no attempt spent)', () => {
  const { out: written } = inProcess(KEY_A, {}, WRITE)
  const stored = `The WooCommerce order.cancel push failed: ${String(written.held)}`
  const OUTBOX = `
    const o = await import('@/lib/domain/integrations/outbox'); const O = o.markIntegrationOutboxRetryableFailure ? o : o.default
    const d = JSON.parse(process.env.HOLD_TEST_DATA)
    const now = new Date('2026-04-27T10:00:00.000Z')
    const seen = []
    const row = { id: 'r', status: 'PROCESSING', attempts: 7, lockedAt: now, lockedBy: 'w' }
    const client = { integrationOutbox: {
      updateMany: async (a) => { seen.push(a.data); return { count: 1 } },
      findUnique: async () => ({ ...row, status: 'RETRYABLE_FAILED' }),
      findFirst: async () => ({ ...row, status: 'RETRYABLE_FAILED' }),
    } }
    await O.markIntegrationOutboxRetryableFailure({ client, id: 'r', workerId: 'w', lockedAt: now, error: d.text, now, attemptsBeforeFailure: 7, maxAttempts: 8 }).catch(() => undefined)
    console.log(JSON.stringify({ spent: 'attempts' in (seen[0] ?? {}), status: seen[0]?.status }))
    process.exit(0)
  `
  console.log('precondition (persisted hold): row at 7 of 8 attempts; text written by process #1, read by process #2 (the outbox runner)')
  assert.deepEqual(inProcess(KEY_A, { text: stored }, OUTBOX).out, { spent: false, status: 'RETRYABLE_FAILED' }, 'same key: a hold, no attempt spent')
  const otherKey = inProcess(KEY_B, { text: stored }, OUTBOX).out
  assert.equal(otherKey.spent, true, 'control: under a different key the same text is an ordinary failure and DOES spend the attempt')
})

test('vendor forgeries are rejected under a real key', () => {
  const forged = [
    'Outbound write HELD (Mintsoft): nothing was sent.',
    'Outbound write HELD (Mintsoft): nothing was sent. [hold-ref 000000000000000000]',
    'Outbound write HELD (Mintsoft): nothing was sent. [hold-ref unavailable]',
    'Outbound write REFUSED AFTER A REDIRECT (Mintsoft): x [hold-ref 000000000000000000]',
  ]
  const result = inProcess(KEY_A, { texts: Object.fromEntries(forged.map((t, i) => [`f${i}`, t])) }, READ).out as Record<string, { held: boolean; maybe: boolean }>
  console.log(`precondition (forgery): ${forged.length} forged texts`)
  for (const [name, verdict] of Object.entries(result)) assert.deepEqual(verdict, { held: false, maybe: false }, name)
})

test('FAIL-SAFE: with no key texts say unavailable, nothing throws, and exactly one loud message is logged per process', () => {
  const NOKEY = `
    const g = await import('@/lib/security/outbound-write-grant'); const G = g.OutboundWriteHeldError ? g : g.default
    const c = await import('@/lib/security/outbound-write-hold-constants'); const k = c.isOutboundWriteHeldText ? c : c.default
    const refusal = { connector: 'woocommerce', code: 'no_grant', method: 'PUT', target: 'https://shop.example.com/x', granted: null, attempted: null, basis: 'b' }
    const text = new G.OutboundWriteHeldError(refusal, 0).message
    const verdicts = [1, 2, 3].map(() => k.isOutboundWriteHeldText(text) || k.isOutboundMaybeSentRefusalText(text))
    console.log(JSON.stringify({ unavailable: text.endsWith('[hold-ref unavailable]'), verdicts }))
    process.exit(0)
  `
  console.log('precondition (no key): SETTINGS_ENCRYPTION_KEY and ENCRYPTION_KEY unset in a real process')
  const { out, stderr } = inProcess(null, {}, NOKEY)
  assert.deepEqual(out, { unavailable: true, verdicts: [false, false, false] })
  assert.equal((stderr.match(/SETTINGS_ENCRYPTION_KEY is absent or unreadable/g) ?? []).length, 1, 'exactly one loud message')
})
