import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test, { type TestContext } from 'node:test'

const SCRIPT = join(process.cwd(), 'scripts/check-connector-fetch-boundaries.mjs')

function runGuard(root: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    // Parent validation runs with `NODE_OPTIONS=--import tsx`; clear it so the
    // subprocess does not try to import tsx from the temporary fixture root.
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
  })
}

function runGuardWithArgs(root: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
  })
}

function createRoot(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'connector-fetch-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function writeFixture(root: string, path: string, content: string) {
  const fullPath = join(root, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

test('connector fetch boundary guard blocks raw fetch in connector paths', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', 'export async function bad() { return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Raw fetch\(\) is not allowed/)
  assert.match(result.stderr, /lib\/connectors\/example\.ts:1/)
})

test('connector fetch boundary guard allows connectorFetch calls', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', 'export async function ok() { return connectorFetch("https://example.test", {}, { connectorName: "Example" }) }\n')

  const result = runGuard(root)

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})

test('connector fetch boundary guard allows structured previous-line waivers', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', [
    '// connector-fetch-boundary-ok: PR-80: third-party SDK owns this transport',
    'export async function waived() { return fetch("https://example.test") }',
    '',
  ].join('\n'))

  const result = runGuard(root)

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})

test('connector fetch boundary guard allows structured trailing-comment waivers', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', 'export async function waived() { return fetch("https://example.test") } // connector-fetch-boundary-ok: PR-80: third-party SDK owns this transport\n')

  const result = runGuard(root)

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})

test('connector fetch boundary guard rejects waiver comments without a structured reason', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', [
    '// connector-fetch-boundary-ok:',
    'export async function bad() { return fetch("https://example.test") }',
    '',
  ].join('\n'))

  const result = runGuard(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /lib\/connectors\/example\.ts:2/)
})

test('connector fetch boundary guard rejects waiver-shaped strings', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', 'export async function bad() { const note = "connector-fetch-boundary-ok: PR-80: no"; return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /lib\/connectors\/example\.ts:1/)
})

test('connector fetch boundary guard scans sync server action files', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'app/actions/order-sync.ts', 'export async function bad() { return fetch("https://example.test") }\n')
  writeFixture(root, 'app/actions/currencies.ts', 'export async function ignored() { return fetch("https://example.test") }\n')
  writeFixture(root, 'app/actions/asynchronous.ts', 'export async function ignored() { return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /app\/actions\/order-sync\.ts:1/)
  assert.doesNotMatch(result.stderr, /app\/actions\/currencies\.ts/)
  assert.doesNotMatch(result.stderr, /app\/actions\/asynchronous\.ts/)
})

test('connector fetch boundary guard scans nested and case-insensitive sync action paths', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'app/actions/sync/orders.ts', 'export async function nested() { return fetch("https://example.test") }\n')
  writeFixture(root, 'app/actions/Sync.ts', 'export async function upper() { return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /app\/actions\/sync\/orders\.ts:1/)
  assert.match(result.stderr, /app\/actions\/Sync\.ts:1/)
})

test('connector fetch boundary guard scans cron routes', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'app/api/cron/reconcile.ts', 'export async function bad() { return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /app\/api\/cron\/reconcile\.ts:1/)
})

test('connector fetch boundary guard recurses connector paths', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/woocommerce/api.ts', 'export async function bad() { return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /lib\/connectors\/woocommerce\/api\.ts:1/)
})

test('connector fetch boundary guard ignores method calls, comments, and strings', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', [
    'export async function method(client) { return client.fetch("https://example.test") }',
    '// example: await fetch("https://example.test")',
    'const doc = `fetch("https://example.test")`',
    'const text = "fetch(\\"https://example.test\\")"',
    '',
  ].join('\n'))

  const result = runGuard(root)

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})

test('connector fetch boundary guard ignores test and build directories', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/__tests__/api.test.ts', 'export async function mock() { return fetch("https://example.test") }\n')
  writeFixture(root, 'lib/connectors/dist/api.js', 'export async function built() { return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})

test('connector fetch boundary guard ignores files outside scanned paths', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'app/utils/foo.ts', 'export async function ignored() { return fetch("https://example.test") }\n')

  const result = runGuard(root)

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})

test('connector fetch boundary guard can report waived call sites', (t) => {
  const root = createRoot(t)
  writeFixture(root, 'lib/connectors/example.ts', [
    '// connector-fetch-boundary-ok: PR-80: third-party SDK owns this transport',
    'export async function waived() { return fetch("https://example.test") }',
    '',
  ].join('\n'))

  const result = runGuardWithArgs(root, ['--list-waived', '--report'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /lib\/connectors\/example\.ts:2/)
  const report = JSON.parse(readFileSync(join(root, 'reports/connector-fetch-boundaries.json'), 'utf8'))
  assert.equal(report.findings.length, 0)
  assert.equal(report.waived.length, 1)
})
