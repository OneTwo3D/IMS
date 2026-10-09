import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test, { after, before, beforeEach, mock } from 'node:test'

import { setOutboundRefusalSink } from '../lib/security/outbound-write-refusal-log'

/**
 * THE SCHEDULED DESPATCH POLL CAN NEVER REACH `POST /api/Auth`.
 *
 * A username/password login at Mintsoft mints a NEW tenant API key and invalidates the old one, breaking every
 * other integration on the tenant: it is a write, whatever it is done on behalf of. The despatch poll is on by
 * default and unattended, so it must run on a fixed key or an unexpired stored key and otherwise decline. Real
 * auth, real client and real transport against a LOCAL listener that records every request it receives; only the
 * database and the sweep's own body are doubled (the sweep body is one real read through the real client).
 */

setOutboundRefusalSink(async () => undefined)

type Mode = 'api_key' | 'credentials'
let mode: Mode = 'credentials'
let storedToken: string | null = null
let tokenExpiresAt: Date | null = null
let serverStatusForList = 200
let baseUrl = ''
const requests: string[] = []
const authHeaders: string[] = []
let deletedSettings = 0

mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsConnection: {
        findFirst: async () => ({ id: 'c1', baseUrl, orderLookupConnector: null, tokenExpiresAt, createdAt: new Date() }),
        update: async () => ({}),
        upsert: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      setting: {
        deleteMany: async () => { deletedSettings += 1; return { count: 1 } },
        upsert: async () => ({}),
      },
      $transaction: async (arg: unknown) => {
        if (typeof arg === 'function') {
          return (arg as (tx: unknown) => Promise<unknown>)({
            setting: { upsert: async () => ({}) },
            wmsConnection: { findFirst: async () => ({ id: 'c1' }), update: async () => ({}), upsert: async () => ({}) },
          })
        }
        return Promise.all(arg as unknown[])
      },
    },
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => (key === 'mintsoft_api_key' ? storedToken : null),
    serializeSettingValue: (_key: string, value: string) => value,
  },
})
mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_auth_mode: mode,
      mintsoft_static_api_key: mode === 'api_key' ? 'FIXED-KEY-1' : '',
      mintsoft_username: 'user',
      mintsoft_password: 'pass',
      mintsoft_webhook_secret: '',
      mintsoft_client_id: '89',
    }),
    resolveMintsoftAuthMode: (value: string) => (value === 'api_key' ? 'api_key' : 'credentials'),
  },
})
// The lease is a database row in production; here it is the identity.
mock.module('@/lib/connectors/mintsoft/api/auth-lock', {
  namedExports: { withMintsoftAuthLock: async (_name: string, run: (ctx: { assertHeld: () => Promise<void> }) => Promise<string>) => run({ assertHeld: async () => undefined }) },
})
// The sweep's body, reduced to one REAL read through the real client.
let sweepRuns = 0
mock.module('@/lib/domain/wms/dispatch-sweep', {
  namedExports: {
    runWmsDispatchSweep: async () => {
      sweepRuns += 1
      const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
      const result = await mintsoftRequest('/api/Order/List?PageNo=1&Limit=1')
      return { read: result.error ? 'failed' : 'ok', error: result.error }
    },
  },
})

function handle(req: IncomingMessage, res: ServerResponse): void {
  const line = `${req.method} ${(req.url ?? '').split('?')[0]}`
  requests.push(line)
  authHeaders.push(Object.values(req.headers).join(' | '))
  req.resume()
  req.on('end', () => {
    if (line === 'POST /api/Auth') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ apiKey: 'MINTED-KEY' }))
      return
    }
    if (line === 'GET /api/Order/List') {
      res.writeHead(serverStatusForList, { 'Content-Type': 'application/json' })
      res.end(serverStatusForList === 200 ? '[]' : '')
      return
    }
    res.writeHead(404); res.end()
  })
}

const server = createServer(handle)
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
})
after(async () => {
  delete process.env.MINTSOFT_WRITE_ALLOWED
  delete process.env.E2E_TEST_MODE
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  requests.length = 0; authHeaders.length = 0; deletedSettings = 0; sweepRuns = 0
  mode = 'credentials'; storedToken = null; tokenExpiresAt = null; serverStatusForList = 200
  // The WRITE grant AND the login grant are present on purpose: the hold must not be what keeps the poll away from /api/Auth.
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89|login=user`
})

const authCalls = () => requests.filter((line) => line === 'POST /api/Auth').length
const FRESH = () => new Date(Date.now() + 6 * 60 * 60 * 1000)
const EXPIRED = () => new Date(Date.now() - 60 * 60 * 1000)

async function poll() {
  const { runMintsoftDispatchPoll } = await import('../lib/connectors/mintsoft/sync/dispatch-poll')
  return runMintsoftDispatchPoll() as Promise<{ skipped?: boolean; reason?: string; read?: string; error?: string }>
}

test('[control] the rig CAN see a login: outside the poll, an expired key in username/password mode requests POST /api/Auth', async () => {
  storedToken = 'OLD'; tokenExpiresAt = EXPIRED()
  const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
  const result = await mintsoftRequest('/api/Order/List?PageNo=1&Limit=1')
  console.log(`precondition (control): requests=${JSON.stringify(requests)} error=${result.error ?? null}`)
  assert.equal(authCalls(), 1, 'the listener received the login the poll must never make')
})

test('fixed API key: the poll runs on the key and never requests /api/Auth', async () => {
  mode = 'api_key'
  const result = await poll()
  console.log(`precondition: requests=${JSON.stringify(requests)} sweep runs=${sweepRuns}`)
  assert.equal(result.read, 'ok')
  assert.equal(authCalls(), 0)
  assert.ok(authHeaders.some((header) => header.includes('FIXED-KEY-1')), 'the fixed key was the credential sent')
})

test('username/password with an UNEXPIRED stored key: the poll runs on it and never requests /api/Auth', async () => {
  storedToken = 'STORED-FRESH'; tokenExpiresAt = FRESH()
  const result = await poll()
  console.log(`precondition: requests=${JSON.stringify(requests)}`)
  assert.equal(result.read, 'ok')
  assert.equal(authCalls(), 0)
  assert.ok(authHeaders.some((header) => header.includes('STORED-FRESH')))
})

test('username/password with an EXPIRED stored key: the poll declines BEFORE any request, naming why, and the sweep does not run', async () => {
  storedToken = 'OLD'; tokenExpiresAt = EXPIRED()
  const result = await poll()
  const { MINTSOFT_POLL_NEEDS_KEY_TEXT } = await import('../lib/connectors/mintsoft/api/auth-no-login')
  console.log(`precondition: requests=${JSON.stringify(requests)} sweep runs=${sweepRuns} skipped=${result.skipped}`)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, MINTSOFT_POLL_NEEDS_KEY_TEXT)
  assert.deepEqual(requests, [], 'nothing at all reached Mintsoft')
  assert.equal(sweepRuns, 0)
})

test('a 401 on the poll\'s read in username/password mode does not log in, does not delete the stored key, and says why', async () => {
  storedToken = 'STORED-FRESH'; tokenExpiresAt = FRESH(); serverStatusForList = 401
  const result = await poll()
  console.log(`precondition: requests=${JSON.stringify(requests)} deleted settings=${deletedSettings} error=${String(result.error).slice(0, 60)}`)
  assert.equal(requests.filter((line) => line === 'GET /api/Order/List').length, 1, 'the read was made once')
  assert.equal(authCalls(), 0, 'and the 401 did not trigger a login')
  assert.equal(deletedSettings, 0, 'the stored key was left alone')
  assert.match(String(result.error), /did not run|Logging in would replace the tenant API key/)
})

test('[isolating] a 401 in the same state OUTSIDE the poll DOES log in: the poll-only scope is what stops it', async () => {
  storedToken = 'STORED-FRESH'; tokenExpiresAt = FRESH(); serverStatusForList = 401
  const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
  await mintsoftRequest('/api/Order/List?PageNo=1&Limit=1')
  console.log(`precondition: requests=${JSON.stringify(requests)}`)
  assert.equal(authCalls(), 1)
})

test('[token guard alone] inside the poll scope a request on an EXPIRED key fails with the sentence and requests no login (the pre-check is bypassed here)', async () => {
  storedToken = 'OLD'; tokenExpiresAt = EXPIRED()
  const { withMintsoftNoLogin } = await import('../lib/connectors/mintsoft/api/auth-no-login')
  const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
  const { MINTSOFT_POLL_NEEDS_KEY_TEXT } = await import('../lib/connectors/mintsoft/api/auth-no-login')
  const result = await withMintsoftNoLogin(() => mintsoftRequest('/api/Order/List?PageNo=1&Limit=1'))
  console.log(`precondition: requests=${JSON.stringify(requests)} error=${String(result.error).slice(0, 50)}`)
  assert.deepEqual(requests, [])
  assert.equal(result.error, MINTSOFT_POLL_NEEDS_KEY_TEXT)
})
