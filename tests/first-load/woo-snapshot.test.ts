/**
 * The read-only WooCommerce snapshot command, driven against a LOCAL FAKE STORE on 127.0.0.1. Nothing here contacts a real host: the suite's own
 * network trap (tests/no-outbound-network.cjs) refuses anything but loopback, and the fake records every request it receives.
 *
 * Every arm asserts and prints its precondition, and is paired with ONE named mutation (listed in the PR) that turns it red. Where two mechanisms
 * could satisfy an arm, an isolating arm removes one of them.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { outboundWriteRefusal } from '../../lib/security/outbound-write-grant.ts'
import { runCli as runPrepare } from '../../lib/first-load/cli.ts'
import { SNAPSHOT_EXIT_CODES, SNAPSHOT_FILE_NAMES } from '../../lib/first-load/spec.ts'
import { parseSnapshotFile, payloadSha256, renderSnapshotFile, renderVariantParentsCsv } from '../../lib/first-load/snapshot.ts'
import { runSnapshotCli, type SnapshotCliDeps } from '../../lib/first-load/woo-snapshot/cli.ts'
import { startFakeCatalogue, type FakeCatalogue, type FakeCatalogueOptions, type FakeParent } from '../helpers/fake-woocommerce-catalogue.ts'
import { precondition } from './helpers.ts'

const KEY = 'ck_test_readonly_key_0000'
const SECRET = 'cs_test_readonly_secret_1111'
const FIXED_NOW = Date.UTC(2026, 9, 9, 12, 0, 0)

const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-woo-snapshot-'))
let counter = 0
const fresh = (label: string) => path.join(scratch, `${label}-${++counter}`)
const savedEnv = { E2E_TEST_MODE: process.env.E2E_TEST_MODE }
before(() => { process.env.E2E_TEST_MODE = '1' })
after(() => {
  if (savedEnv.E2E_TEST_MODE === undefined) delete process.env.E2E_TEST_MODE
  else process.env.E2E_TEST_MODE = savedEnv.E2E_TEST_MODE
  rmSync(scratch, { recursive: true, force: true })
})

function catalogue(): FakeParent[] {
  return [
    {
      id: 100, sku: 'WIDGET', name: 'Widget', status: 'publish',
      variations: [
        { id: 1001, sku: 'W-01', attributes: [{ name: 'Colour', option: 'Red' }] },
        { id: 1002, sku: 'W-02', attributes: [{ name: 'Colour', option: 'Blue' }] },
        { id: 1003, sku: 'W-03', status: 'private', attributes: [{ name: 'Colour', option: 'Green' }] },
      ],
    },
    { id: 200, sku: 'GADGET', name: 'Gadget', status: 'draft', variations: [{ id: 2001, sku: 'G-01' }, { id: 2002, sku: '' }] },
    { id: 300, sku: 'EMPTY', name: 'No variations yet', status: 'publish', variations: [] },
    { id: 400, sku: 'BIG', name: 'Big', status: 'private', variations: [1, 2, 3, 4, 5].map((n) => ({ id: 4000 + n, sku: `B-0${n}` })) },
  ]
}

interface Rig {
  server: FakeCatalogue
  envFile: string
  out: string
}

async function rig(options: Partial<FakeCatalogueOptions> = {}, parents: FakeParent[] = catalogue()): Promise<Rig> {
  const server = await startFakeCatalogue({ key: KEY, secret: SECRET, parents, ...options })
  const envFile = fresh('creds')
  writeFileSync(envFile, `# read-only key\nFIRST_LOAD_WOO_URL=${server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET="${SECRET}"\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  return { server, envFile, out: fresh('out') }
}

interface Ran { code: number; stdout: string; stderr: string; sleeps: number[]; callClock: number[] }

async function snapshot(r: Rig, extra: string[] = [], deps: SnapshotCliDeps = {}, base: string[] | null = null): Promise<Ran> {
  let stdout = ''
  let stderr = ''
  const sleeps: number[] = []
  const callClock: number[] = []
  let clock = FIXED_NOW
  const args = base ?? ['--env-file', r.envFile, '--out', r.out, '--allow-origin', r.server.origin, '--min-interval-ms', '0']
  const code = await runSnapshotCli([...args, ...extra], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, {
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
    now: () => clock,
    ...deps,
  })
  void callClock
  return { code, stdout, stderr, sleeps, callClock }
}

const listFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : [])
const requestsTo = (server: FakeCatalogue, pathname: string, page?: number) => server.requests.filter((q) => q.path.endsWith(pathname) && (page === undefined || q.query.page === String(page))).length

test('arm (a): a complete walk over several pages writes the snapshot, its provenance and variant-parents.csv, and proves the counts', async (t) => {
  const r = await rig({ pageSizeCap: 2 })
  try {
    const ran = await snapshot(r)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.OK, ran.stderr)
    precondition(t, 'requests served', r.server.requests.length)
    precondition(t, 'product pages walked', r.server.requests.filter((q) => q.path.endsWith('/products')).length)
    assert.ok(r.server.requests.filter((q) => q.path.endsWith('/products')).length >= 2, 'the store granted 2 rows a page, so the walk must page')
    assert.deepEqual(listFiles(r.out), [SNAPSHOT_FILE_NAMES.provenance, SNAPSHOT_FILE_NAMES.snapshot, SNAPSHOT_FILE_NAMES.variantParents, SNAPSHOT_FILE_NAMES.variantParentsInspection].sort())
    const parsed = parseSnapshotFile(readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.snapshot), 'utf8'))
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    assert.equal(parsed.payload.parents.length, 4)
    assert.equal(parsed.payload.variations.length, 10)
    assert.deepEqual(parsed.payload.variations.find((v) => v.id === 1003), { id: 1003, parentId: 100, sku: 'W-03', status: 'private', attributes: [{ name: 'Colour', option: 'Green' }] }, 'a private variation and its attributes are kept')
    const csv = readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.variantParents), 'utf8')
    assert.equal(csv, renderVariantParentsCsv(parsed.payload))
    assert.equal(csv.split('\r\n').filter(Boolean).length, 1 + 9, 'nine variations have a SKU; the one without is counted, not listed')
    assert.match(csv, /W-01,1001,WIDGET,Widget,publish,100/)
    const provenance = JSON.parse(readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.provenance), 'utf8'))
    assert.equal(provenance.origin, r.server.origin)
    assert.equal(provenance.proof.parents.rowsRead, provenance.proof.parents.totalHeader)
    assert.equal(provenance.proof.variations.rowsRead, provenance.proof.variations.totalHeaderSum)
    assert.equal(provenance.proof.variationsWithoutSku, 1)
    assert.match(ran.stdout, /4 read = 4 \(X-WP-Total\)/)
  } finally { await r.server.close() }
})

test('arm (b): every request is a GET, and the outbound-write hold classifies each of them as a read', async (t) => {
  const r = await rig({ pageSizeCap: 2 })
  try {
    assert.equal((await snapshot(r)).code, SNAPSHOT_EXIT_CODES.OK)
    precondition(t, 'requests examined', r.server.requests.length)
    assert.deepEqual(r.server.writeViolations(), [])
    assert.ok(r.server.requests.every((q) => q.method === 'GET'))
    // With NO grant (the hold's default), a GET to exactly these URLs is not refused ...
    const urls = [...new Set(r.server.requests.map((q) => `${r.server.origin}${q.path}`))]
    precondition(t, 'distinct URLs checked against the hold', urls.length)
    for (const url of urls) {
      assert.equal(outboundWriteRefusal({ connectorName: 'WooCommerce', method: 'GET', url: new URL(url), env: {} }), null, url)
    }
    // ... and the same check CAN fail: a POST to the same URL is refused.
    const refused = urls.filter((url) => outboundWriteRefusal({ connectorName: 'WooCommerce', method: 'POST', url: new URL(url), env: {} }) !== null)
    assert.equal(refused.length, urls.length, 'the control: a write to the same URLs is held')
  } finally { await r.server.close() }
})

const SOURCES = [
  'lib/first-load/woo-snapshot/walk.ts',
  'lib/first-load/woo-snapshot/cli.ts',
  'lib/first-load/snapshot.ts',
  'scripts/first-load-woo-snapshot.ts',
]
const FORBIDDEN: Array<[string, RegExp]> = [
  ['a connector write function', /\bwc(?:Post|Put|Delete|Patch)\b/],
  ['a write method', /method:\s*['"`](?:POST|PUT|PATCH|DELETE)/i],
  ['a raw fetch', /\bfetch\s*\(/],
  ['the transport directly', /\bconnectorFetch\b/],
  ['the IMS database', /from ['"](?:@\/lib\/db|@\/lib\/settings-store|\.\.?\/.*\/db)['"]|\bgetWcCredentials\b|new PrismaClient|PrismaPg/],
  ['an environment read', /process\.env\b/],
]

test('arm (c): the snapshot code has no write function, no raw fetch, no database or settings read (universal absence)', (t) => {
  let lines = 0
  const hits: string[] = []
  const files = [...SOURCES]
  for (const file of files) {
    const text = readFileSync(path.join(process.cwd(), file), 'utf8')
    lines += text.split('\n').length
    text.split('\n').forEach((line, index) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
      for (const [what, pattern] of FORBIDDEN) if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${what}: ${line.trim()}`)
    })
  }
  precondition(t, 'files scanned', files.length)
  precondition(t, 'lines scanned', lines)
  assert.deepEqual(hits, [])
  // The scan can fail: each pattern matches a sample line.
  const samples: Record<string, string> = {
    'a connector write function': "import { wcPost } from '@/lib/connectors/woocommerce/api'",
    'a write method': "{ method: 'POST' }",
    'a raw fetch': 'await fetch(url)',
    'the transport directly': 'connectorFetch(url, init, opts)',
    'the IMS database': "import { db } from '@/lib/db'",
    'an environment read': 'process.env.HOME',
  }
  precondition(t, 'patterns exercised', FORBIDDEN.length)
  for (const [what, pattern] of FORBIDDEN) assert.ok(pattern.test(samples[what]), what)
})

test('arm (c2): the read function is called with the credentials from the file; the IMS database is never consulted', async (t) => {
  const r = await rig()
  const saved = process.env.DATABASE_URL
  // Unreachable on purpose: a settings read would fail (or hang to a connect error) instead of finding credentials.
  process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:9/none'
  try {
    const ran = await snapshot(r, [], { sleep: async () => {}, now: undefined })
    precondition(t, 'requests served with credentials from the file', r.server.requests.filter((q) => q.authenticated).length)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.OK, ran.stderr)
    assert.ok(r.server.requests.every((q) => q.authenticated))
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
    await r.server.close()
  }
})

test('arm (d): a page the store did not serve is an error: nothing is written (parents)', async (t) => {
  let dropped = 0
  const r = await rig({
    pageSizeCap: 2,
    intercept: (c, res) => {
      if (c.route === 'products' && c.page === 2) { dropped++; return { ...res, body: [] } }
      return res
    },
  })
  try {
    const ran = await snapshot(r)
    precondition(t, 'pages the fake emptied', dropped)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.match(ran.stderr, /variable product\(s\) were read but the store's X-WP-Total says 4/)
    assert.deepEqual(listFiles(r.out), [], 'no snapshot, no partial walk')
  } finally { await r.server.close() }
})

test('arm (d2): a variation page that is short against the header total is an error (the header proof, isolated)', async (t) => {
  let shorted = 0
  const parents = catalogue()
  const r = await rig({
    intercept: (c, res) => {
      // The store serves two of WIDGET's three variations but still says three, and the parent still lists three.
      if (c.route === 'variations' && c.parentId === 100) { shorted++; return { ...res, body: (res.body as unknown[]).slice(0, 2) } }
      return res
    },
  }, parents)
  try {
    const ran = await snapshot(r)
    precondition(t, 'variation pages shortened', shorted)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.match(ran.stderr, /2 variation\(s\) of product 100 were read but the store's X-WP-Total says 3/)
  } finally { await r.server.close() }
})

test('arm (d3): the parent\'s own list of variation ids must equal what was read (the id-list proof, isolated: the header is truthful)', async (t) => {
  const parents = catalogue()
  parents[0].advertisedVariationIds = [1001, 1002, 1003, 1004]
  const r = await rig({}, parents)
  try {
    const ran = await snapshot(r)
    precondition(t, 'parents advertising an id that was not served', 1)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.match(ran.stderr, /parent 100 lists variations \[1001, 1002, 1003, 1004\] but \[1001, 1002, 1003\] were read/)
    assert.deepEqual(listFiles(r.out), [])
  } finally { await r.server.close() }
})

test('arm (e): a store that sends no readable totals cannot be proved complete', async (t) => {
  const r = await rig({ omitPaginationHeaders: true })
  try {
    const ran = await snapshot(r)
    precondition(t, 'requests served without totals', r.server.requests.length)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.match(ran.stderr, /completeness cannot be proved/)
    assert.deepEqual(listFiles(r.out), [])
  } finally { await r.server.close() }
})

test('arm (f): a store whose product pagination changes during the walk is an error (totals compared page to page, isolated)', async (t) => {
  let changed = 0
  const r = await rig({
    pageSizeCap: 2,
    intercept: (c, res) => {
      // Page 2 keeps the same X-WP-Total (4, so rows == total still holds) but claims three pages: only the page-to-page comparison sees it.
      if (c.route === 'products' && c.page === 2) { changed++; return { ...res, headers: { ...res.headers, 'x-wp-totalpages': '3' } } }
      return res
    },
  })
  try {
    const ran = await snapshot(r)
    precondition(t, 'responses whose page count changed', changed)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.match(ran.stderr, /moved during the walk/)
    assert.deepEqual(listFiles(r.out), [])
  } finally { await r.server.close() }
})

test('arm (g): a repeated variation SKU (letter case ignored) is an error and nothing is written', async (t) => {
  const parents = catalogue()
  parents[1].variations.push({ id: 2003, sku: 'w-01' })
  const r = await rig({}, parents)
  try {
    const ran = await snapshot(r)
    precondition(t, 'repeated SKUs in the store', 1)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.match(ran.stderr, /variation SKU W-01 is used by variations 1001, 2003/)
    assert.deepEqual(listFiles(r.out), [])
  } finally { await r.server.close() }
})

test('arm (g2): a parent without a SKU, a parent that is not variable, and a mismatching parent_id are each an error', async (t) => {
  const cases: Array<{ name: string; edit: (p: FakeParent[]) => void; match: RegExp }> = [
    { name: 'blank parent SKU', edit: (p) => { p[2].sku = '' }, match: /parent 300 has a blank SKU/ },
    { name: 'not variable', edit: (p) => { p[2].type = 'simple' }, match: /has type "simple", not "variable"/ },
    { name: 'parent_id mismatch', edit: (p) => { p[0].variations[0].parent_id = 999 }, match: /says its parent is 999/ },
  ]
  precondition(t, 'cases', cases.length)
  for (const c of cases) {
    const parents = catalogue()
    c.edit(parents)
    const r = await rig({}, parents)
    try {
      const ran = await snapshot(r)
      assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, `${c.name}: ${ran.stderr}`)
      assert.match(ran.stderr, c.match, c.name)
      assert.deepEqual(listFiles(r.out), [], c.name)
    } finally { await r.server.close() }
  }
})

test('arm (g3): a store with no variable products is refused, not written as an empty snapshot', async (t) => {
  const r = await rig({}, [])
  try {
    const ran = await snapshot(r)
    precondition(t, 'requests served', r.server.requests.length)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.deepEqual(listFiles(r.out), [])
  } finally { await r.server.close() }
})

test('arm (h): the origin allowlist: a store that is not on it is never contacted, an explicit flag or an allowlist entry in the file lets it through', async (t) => {
  const r = await rig()
  try {
    const noList = await snapshot(r, [], {}, ['--env-file', r.envFile, '--out', r.out, '--min-interval-ms', '0'])
    precondition(t, 'refusals', 1)
    assert.equal(noList.code, SNAPSHOT_EXIT_CODES.REFUSED, noList.stderr)
    assert.match(noList.stderr, /is not on the allowlist/)
    const wrong = await snapshot(r, [], {}, ['--env-file', r.envFile, '--out', r.out, '--allow-origin', 'https://shop.example', '--min-interval-ms', '0'])
    assert.equal(wrong.code, SNAPSHOT_EXIT_CODES.REFUSED, wrong.stderr)
    assert.equal(r.server.requests.length, 0, 'NOT ONE request reached the store while it was not allowlisted')
    assert.equal(existsSync(r.out), false, 'and nothing was created')
    const flagged = await snapshot(r, [], {}, ['--env-file', r.envFile, '--out', r.out, '--allow-any-origin', '--min-interval-ms', '0'])
    assert.equal(flagged.code, SNAPSHOT_EXIT_CODES.OK, flagged.stderr)
    assert.ok(r.server.requests.length > 0, 'the explicit flag lets the same store through')
    // An allowlist entry in the credentials file also counts.
    const r2 = { ...r, out: fresh('out'), envFile: fresh('creds') }
    writeFileSync(r2.envFile, `FIRST_LOAD_WOO_URL=${r.server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\nFIRST_LOAD_WOO_ALLOWED_ORIGINS=https://other.example, ${r.server.origin}\n`, { mode: 0o600 })
    assert.equal((await snapshot(r2, [], {}, ['--env-file', r2.envFile, '--out', r2.out, '--min-interval-ms', '0'])).code, SNAPSHOT_EXIT_CODES.OK)
  } finally { await r.server.close() }
})

test('arm (i): the credentials file: group-readable, a link, a missing value and an unknown key are each refused before any request; no secret is echoed or written', async (t) => {
  const r = await rig()
  try {
    const bad: Array<{ name: string; make: () => string; match: RegExp }> = [
      { name: 'mode 644', make: () => { const f = fresh('creds'); writeFileSync(f, `FIRST_LOAD_WOO_URL=${r.server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\n`); chmodSync(f, 0o644); return f }, match: /readable by group or others/ },
      { name: 'a symlink', make: () => { const f = fresh('link'); symlinkSync(r.envFile, f); return f }, match: /regular file/ },
      { name: 'a missing secret', make: () => { const f = fresh('creds'); writeFileSync(f, `FIRST_LOAD_WOO_URL=${r.server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\n`, { mode: 0o600 }); return f }, match: /does not set FIRST_LOAD_WOO_SECRET/ },
      { name: 'an unknown key', make: () => { const f = fresh('creds'); writeFileSync(f, `FIRST_LOAD_WOO_URL=${r.server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\nFIRST_LOAD_WOO_SECERT=x\n`, { mode: 0o600 }); return f }, match: /not one of/ },
      { name: 'a line that is not KEY=VALUE', make: () => { const f = fresh('creds'); writeFileSync(f, `${SECRET}\n`, { mode: 0o600 }); return f }, match: /line 1 .* is not KEY=VALUE/ },
    ]
    precondition(t, 'bad credential files', bad.length)
    const texts: string[] = []
    for (const b of bad) {
      const file = b.make()
      const ran = await snapshot(r, [], {}, ['--env-file', file, '--out', fresh('out'), '--allow-origin', r.server.origin])
      assert.equal(ran.code, SNAPSHOT_EXIT_CODES.REFUSED, `${b.name}: ${ran.stderr}`)
      assert.match(ran.stderr, b.match, b.name)
      texts.push(ran.stdout, ran.stderr)
    }
    assert.equal(r.server.requests.length, 0, 'no request left for any of them')
    const ok = await snapshot(r)
    assert.equal(ok.code, SNAPSHOT_EXIT_CODES.OK)
    texts.push(ok.stdout, ok.stderr, ...readdirSync(r.out).map((n) => readFileSync(path.join(r.out, n), 'utf8')))
    precondition(t, 'texts searched for the key and the secret', texts.length)
    for (const text of texts) {
      assert.ok(!text.includes(SECRET) && !text.includes(KEY), 'a credential was echoed or written')
    }
  } finally { await r.server.close() }
})

test('arm (i2): credentials are never accepted on the command line', async (t) => {
  const r = await rig()
  try {
    for (const flag of ['--key', '--secret', '--url', '--consumer-key']) {
      const ran = await snapshot(r, [flag, 'x'])
      assert.equal(ran.code, SNAPSHOT_EXIT_CODES.USAGE, flag)
      assert.match(ran.stderr, /never accepted on the command line/)
    }
    precondition(t, 'flags refused', 4)
    assert.equal(r.server.requests.length, 0)
  } finally { await r.server.close() }
})

test('arm (j): a walk that failed part-way resumes without asking for a finished page again, and ends with the same bytes as a clean walk', async (t) => {
  const clean = await rig({ pageSizeCap: 2 })
  let failing = true
  const r = await rig({
    pageSizeCap: 2,
    intercept: (c, res) => (failing && c.route === 'products' && c.page === 2 ? { status: 500, headers: {}, body: { code: 'boom', message: 'boom' } } : res),
  })
  try {
    assert.equal((await snapshot(clean)).code, SNAPSHOT_EXIT_CODES.OK)
    const first = await snapshot(r)
    assert.equal(first.code, SNAPSHOT_EXIT_CODES.FETCH_FAILED, first.stderr)
    assert.match(first.stderr, /--resume/)
    assert.deepEqual(listFiles(r.out), [SNAPSHOT_FILE_NAMES.partial], 'what was read is kept')
    const page1Before = requestsTo(r.server, '/products', 1)
    precondition(t, 'page-1 requests before the resume', page1Before)
    // Without --resume the unfinished walk is not silently replaced.
    const refused = await snapshot(r)
    assert.equal(refused.code, SNAPSHOT_EXIT_CODES.OUTPUT_FAILED)
    assert.match(refused.stderr, /add --resume/)
    failing = false
    const resumed = await snapshot(r, ['--resume'])
    assert.equal(resumed.code, SNAPSHOT_EXIT_CODES.OK, resumed.stderr)
    assert.equal(requestsTo(r.server, '/products', 1), page1Before + 1, 'page 1 was not requested again by the resumed walk; the one extra request is the verifying second walk')
    assert.deepEqual(listFiles(r.out), [SNAPSHOT_FILE_NAMES.provenance, SNAPSHOT_FILE_NAMES.snapshot, SNAPSHOT_FILE_NAMES.variantParents, SNAPSHOT_FILE_NAMES.variantParentsInspection].sort(), 'the partial walk is removed once the snapshot is complete')
    for (const name of [SNAPSHOT_FILE_NAMES.snapshot, SNAPSHOT_FILE_NAMES.variantParents]) {
      assert.equal(readFileSync(path.join(r.out, name), 'utf8'), readFileSync(path.join(clean.out, name), 'utf8'), name)
    }
    assert.equal(JSON.parse(readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.provenance), 'utf8')).resumed, true)
  } finally { await r.server.close(); await clean.server.close() }
})

test('arm (j2): an unfinished walk of one store is not resumed against another', async (t) => {
  let failing = true
  const a = await rig({ pageSizeCap: 2, intercept: (c, res) => (failing && c.route === 'products' && c.page === 2 ? { status: 500, headers: {}, body: {} } : res) })
  const b = await rig()
  try {
    assert.equal((await snapshot(a)).code, SNAPSHOT_EXIT_CODES.FETCH_FAILED)
    failing = false
    const before = b.server.requests.length
    const ran = await snapshot(b, ['--resume'], {}, ['--env-file', b.envFile, '--out', a.out, '--allow-origin', b.server.origin, '--min-interval-ms', '0'])
    precondition(t, 'resumes attempted against another store', 1)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.REFUSED, ran.stderr)
    assert.match(ran.stderr, /belongs to /)
    assert.equal(b.server.requests.length, before, 'the other store was not asked anything')
  } finally { await a.server.close(); await b.server.close() }
})

test('arm (k): a transient server error is retried with a growing wait, a client error is not', async (t) => {
  let flaky = 0
  const r = await rig({ intercept: (c, res) => (c.route === 'products' && c.attempt === 1 && flaky++ === 0 ? { status: 503, headers: {}, body: { message: 'later' } } : res) })
  const denied = await rig({ intercept: () => ({ status: 403, headers: {}, body: { code: 'woocommerce_rest_cannot_view', message: 'no' } }) })
  try {
    const ran = await snapshot(r, ['--min-interval-ms', '0'])
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.OK, ran.stderr)
    precondition(t, 'retry waits recorded', ran.sleeps.filter((ms) => ms >= 1000).length)
    assert.deepEqual(ran.sleeps.filter((ms) => ms >= 1000), [1000])
    const refused = await snapshot(denied)
    assert.equal(refused.code, SNAPSHOT_EXIT_CODES.FETCH_FAILED)
    assert.equal(denied.server.requests.length, 1, 'a 403 is asked once')
  } finally { await r.server.close(); await denied.server.close() }
})

test('arm (l): the rate limit: consecutive requests are at least the minimum interval apart', async (t) => {
  const r = await rig({ pageSizeCap: 2 })
  try {
    let clock = FIXED_NOW
    const stamps: number[] = []
    const { wcFetch } = await import('../../lib/connectors/woocommerce/api.ts')
    let stdout = ''
    let stderr = ''
    const code = await runSnapshotCli(['--env-file', r.envFile, '--out', r.out, '--allow-origin', r.server.origin, '--min-interval-ms', '300'], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, {
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      makeFetchPage: async (creds) => (p, params) => { stamps.push(clock); return wcFetch(p, params, creds) },
    })
    assert.equal(code, SNAPSHOT_EXIT_CODES.OK, stderr)
    const gaps = stamps.slice(1).map((s, i) => s - stamps[i])
    precondition(t, 'gaps between consecutive requests', gaps.length)
    assert.ok(gaps.every((g) => g >= 300), `gaps: ${gaps.join(',')}`)
    void stdout
  } finally { await r.server.close() }
})

test('arm (m): the same store gives the same bytes whatever page size it grants or order it answers in', async (t) => {
  const a = await rig({ pageSizeCap: 2 })
  const b = await rig({ pageSizeCap: 100, intercept: (_c, res) => (Array.isArray(res.body) ? { ...res, body: [...res.body].reverse() } : res) })
  try {
    assert.equal((await snapshot(a)).code, SNAPSHOT_EXIT_CODES.OK)
    assert.equal((await snapshot(b)).code, SNAPSHOT_EXIT_CODES.OK)
    let compared = 0
    for (const name of [SNAPSHOT_FILE_NAMES.snapshot, SNAPSHOT_FILE_NAMES.variantParents]) {
      assert.equal(readFileSync(path.join(a.out, name), 'utf8'), readFileSync(path.join(b.out, name), 'utf8'), name)
      compared++
    }
    precondition(t, 'files compared', compared)
    assert.notEqual(a.server.requests.length, b.server.requests.length, 'the two walks really did differ in how they paged')
    assert.ok(!readFileSync(path.join(a.out, SNAPSHOT_FILE_NAMES.snapshot), 'utf8').includes(a.server.origin), 'the snapshot itself carries no host (the provenance does)')
  } finally { await a.server.close(); await b.server.close() }
})

test('arm (m2): the canonical form sorts by id whatever order it is given (the sort in the snapshot module itself, isolated from the walk)', (t) => {
  const sorted = { source: 'woocommerce' as const, parents: [
    { id: 1, sku: 'A', name: 'A', status: 'publish', variationIds: [11, 12] },
    { id: 2, sku: 'B', name: 'B', status: 'publish', variationIds: [21] },
  ], variations: [
    { id: 11, parentId: 1, sku: 'A-1', status: 'publish', attributes: [{ name: 'a', option: '1' }, { name: 'b', option: '2' }] },
    { id: 12, parentId: 1, sku: 'A-2', status: 'publish', attributes: [] },
    { id: 21, parentId: 2, sku: 'B-1', status: 'publish', attributes: [] },
  ] }
  const shuffled = {
    source: 'woocommerce' as const,
    parents: [sorted.parents[1], { ...sorted.parents[0], variationIds: [12, 11] }],
    variations: [sorted.variations[2], { ...sorted.variations[0], attributes: [{ name: 'b', option: '2' }, { name: 'a', option: '1' }] }, sorted.variations[1]],
  }
  precondition(t, 'orderings compared', 2)
  assert.equal(renderSnapshotFile(shuffled), renderSnapshotFile(sorted))
  assert.equal(payloadSha256(shuffled), payloadSha256(sorted))
})

test('arm (n): --verify recomputes the checksum: an edited snapshot is refused, an untouched one passes, and --verify takes no other option', async (t) => {
  const r = await rig()
  try {
    assert.equal((await snapshot(r)).code, SNAPSHOT_EXIT_CODES.OK)
    const file = path.join(r.out, SNAPSHOT_FILE_NAMES.snapshot)
    const good = await snapshot(r, [], {}, ['--verify', file])
    precondition(t, 'verifications', 1)
    assert.equal(good.code, SNAPSHOT_EXIT_CODES.OK, good.stderr)
    assert.match(good.stdout, /4 variable product\(s\), 10 variation\(s\)/)
    const edited = fresh('edited.json')
    writeFileSync(edited, readFileSync(file, 'utf8').replace('"sku": "W-01"', '"sku": "W-99"'))
    const bad = await snapshot(r, [], {}, ['--verify', edited])
    assert.equal(bad.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
    assert.match(bad.stderr, /checksum does not match/)
    assert.equal((await snapshot(r, [], {}, ['--verify', file, '--out', 'x'])).code, SNAPSHOT_EXIT_CODES.USAGE)
    assert.equal((await snapshot(r, [], {}, ['--verify', fresh('missing.json')])).code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  } finally { await r.server.close() }
})

test('arm (o): end to end: the snapshot\'s variant-parents.csv, fed to first-load:prepare with Qoblex-style variants, produces the VARIABLE parents', async (t) => {
  const r = await rig({ pageSizeCap: 3 })
  try {
    assert.equal((await snapshot(r)).code, SNAPSHOT_EXIT_CODES.OK)
    const dir = fresh('prepare')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'products.csv'), 'sku,name,type\nW-01,Qoblex widget red,VARIANT\nW-02,Qoblex widget blue,VARIANT\nG-01,Qoblex gadget,VARIANT\nB-01,Qoblex big,VARIANT\n')
    writeFileSync(path.join(dir, 'variant-parents.csv'), readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.variantParents)))
    writeFileSync(path.join(dir, 'exclusions.csv'), 'sku,reason\nW-03,not loaded at first\nB-02,not loaded at first\nB-03,not loaded at first\nB-04,not loaded at first\nB-05,not loaded at first\n')
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      formatVersion: 1, baseCurrency: 'GBP',
      inputs: [
        { dataset: 'products', file: 'products.csv' },
        { dataset: 'variant-parents', file: 'variant-parents.csv' },
        { dataset: 'sku-exclusions', file: 'exclusions.csv' },
      ],
    }))
    let stdout = ''
    let stderr = ''
    const out = fresh('prepared')
    const code = await runPrepare(['--manifest', path.join(dir, 'manifest.json'), '--out', out], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
    assert.equal(code, 0, stdout + stderr)
    const products = readFileSync(path.join(out, '02-products-001-of-001.csv'), 'utf8').split('\r\n').filter(Boolean)
    precondition(t, 'product rows written', products.length - 1)
    const bySku = Object.fromEntries(products.slice(1).map((l) => { const c = l.split(','); return [c[2], c] }))
    assert.equal(bySku.WIDGET[5], 'VARIABLE')
    assert.equal(bySku.WIDGET[3], 'Widget')
    assert.equal(bySku['W-01'][6], 'WIDGET')
    assert.equal(bySku.BIG[5], 'VARIABLE')
    assert.ok(!('EMPTY' in bySku), 'a WooCommerce parent without variations is not loaded')
  } finally { await r.server.close() }
})

// ---------------------------------------------------------------------------
// Review round 1: stability, redirects, error text, resume age, formula cells
// ---------------------------------------------------------------------------

test('arm (q): a stable store is confirmed by a second complete walk (round 1)', async (t) => {
  const r = await rig({ pageSizeCap: 2 })
  try {
    const ran = await snapshot(r)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.OK, ran.stderr)
    precondition(t, 'page-1 product requests (one per walk)', requestsTo(r.server, '/products', 1))
    assert.equal(requestsTo(r.server, '/products', 1), 2, 'the walk and the verifying walk')
    assert.equal(JSON.parse(readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.provenance), 'utf8')).verificationRounds, 1)
    assert.ok(r.server.requests.every((q) => q.query.orderby === 'id' && q.query.order === 'asc'), 'the ordering is explicit on every request')
  } finally { await r.server.close() }
})

test('arm (q2): a product deleted on page 1 and another added at the end before page 2 (total unchanged, a survivor skipped) is detected, and the next round reads the real catalogue', async (t) => {
  const parents = catalogue()
  const ghosts: FakeParent[] = []
  let fired = 0
  const r = await rig({
    pageSizeCap: 2,
    ghosts,
    intercept: (c, res) => {
      if (c.route === 'products' && c.page === 1 && fired === 0) {
        fired++
        ghosts.push(...parents.splice(0, 1)) // delete id 100, which page 1 already carries (its variations still answer, so only the second walk can see it)
        parents.push({ id: 500, sku: 'NEWEST', name: 'Added meanwhile', variations: [{ id: 5001, sku: 'N-01' }] })
      }
      return res
    },
  }, parents)
  try {
    const ran = await snapshot(r)
    precondition(t, 'mutations the store made between pages', fired)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.OK, ran.stderr)
    const parsed = parseSnapshotFile(readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.snapshot), 'utf8'))
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    assert.deepEqual(parsed.payload.parents.map((p) => p.id), [200, 300, 400, 500], 'the survivor 300 is not skipped, the deleted 100 is gone')
    assert.equal(JSON.parse(readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.provenance), 'utf8')).verificationRounds, 2)
  } finally { await r.server.close() }
})

test('arm (q3): a store that never stops changing is refused after the bounded rounds, and nothing is written', async (t) => {
  const parents = catalogue()
  let next = 600
  let fired = 0
  const r = await rig({
    pageSizeCap: 2,
    intercept: (c, res) => {
      if (c.route === 'products' && c.page === 1) {
        fired++
        parents.splice(0, 1)
        parents.push({ id: next, sku: `CHURN${next}`, name: 'churn', variations: [{ id: next + 1, sku: `C-${next}` }] })
        next += 10
      }
      return res
    },
  }, parents)
  try {
    const ran = await snapshot(r)
    precondition(t, 'mutations the store made', fired)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, ran.stderr)
    assert.match(ran.stderr, /not stable enough/)
    assert.deepEqual(listFiles(r.out), [])
  } finally { await r.server.close() }
})

test('arm (r): a redirect is refused and its target is never requested (cross-origin, and same-origin as the isolating case)', async (t) => {
  const other = await startFakeCatalogue({ key: KEY, secret: SECRET, parents: catalogue() })
  let crossed = 0
  const r = await rig({ intercept: (c, res) => (c.route === 'products' ? (crossed++, { status: 302, headers: { location: `${other.origin}/wp-json/wc/v3/products?type=variable` }, body: {} }) : res) })
  let again = 0
  const same = await rig({ intercept: (c, res) => (c.route === 'products' && c.attempt === 1 && again++ === 0 ? { status: 302, headers: { location: `${same_origin()}/wp-json/wc/v3/products?type=variable&status=any&per_page=100&page=1&orderby=id&order=asc` }, body: {} } : res) })
  function same_origin(): string { return same.server.origin }
  try {
    const ran = await snapshot(r)
    precondition(t, 'redirects the store answered with', crossed)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.FETCH_FAILED, ran.stderr)
    assert.match(ran.stderr, /redirect, which is refused/)
    assert.equal(other.requests.length, 0, 'NOT ONE request reached the other origin')
    const ranSame = await snapshot(same)
    assert.equal(ranSame.code, SNAPSHOT_EXIT_CODES.FETCH_FAILED, ranSame.stderr)
    assert.equal(same.server.requests.length, 1, 'the same-origin Location was not followed either')
  } finally { await r.server.close(); await same.server.close(); await other.close() }
})

test('arm (s): an upstream error body that echoes the credentials never reaches any output: status and code only', async (t) => {
  const token = Buffer.from(`${KEY}:${SECRET}`).toString('base64')
  let served = 0
  const r = await rig({ intercept: (c, res) => (c.route === 'products' ? (served++, { status: 500, headers: {}, body: { code: 'internal_error', message: `Authorization: Basic ${token} key=${KEY} secret=${SECRET}` } }) : res) })
  try {
    const ran = await snapshot(r)
    precondition(t, 'error responses carrying the credentials', served)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.FETCH_FAILED)
    assert.match(ran.stderr, /HTTP 500 \(internal_error\)/)
    const all = [ran.stdout, ran.stderr, ...(existsSync(r.out) ? readdirSync(r.out).map((n) => readFileSync(path.join(r.out, n), 'utf8')) : [])]
    precondition(t, 'output texts searched', all.length)
    for (const text of all) assert.ok(!text.includes(token) && !text.includes(SECRET) && !text.includes(KEY), 'a credential reached an output')
  } finally { await r.server.close() }
})

test('arm (s2): the redaction backstop alone: a credential that arrives as store data (a product type) is removed from the message', async (t) => {
  const parents = catalogue()
  parents[2].type = SECRET
  const r = await rig({}, parents)
  try {
    const ran = await snapshot(r)
    precondition(t, 'messages that quote store data', 1)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
    assert.ok(!ran.stderr.includes(SECRET))
    assert.match(ran.stderr, /\[redacted\]/)
  } finally { await r.server.close() }
})

test('arm (t): an unfinished walk older than the allowed age is not resumed, and a young one is', async (t) => {
  let failing = true
  const r = await rig({ pageSizeCap: 2, intercept: (c, res) => (failing && c.route === 'products' && c.page === 2 ? { status: 500, headers: {}, body: {} } : res) })
  try {
    assert.equal((await snapshot(r)).code, SNAPSHOT_EXIT_CODES.FETCH_FAILED)
    failing = false
    const before = r.server.requests.length
    const old = await snapshot(r, ['--resume'], { now: () => FIXED_NOW + 2 * 3_600_000 })
    precondition(t, 'resumes of a walk two hours old', 1)
    assert.equal(old.code, SNAPSHOT_EXIT_CODES.REFUSED, old.stderr)
    assert.match(old.stderr, /older than 60 minute/)
    assert.equal(r.server.requests.length, before, 'nothing was requested')
    const young = await snapshot(r, ['--resume'], { now: () => FIXED_NOW + 5 * 60_000 })
    assert.equal(young.code, SNAPSHOT_EXIT_CODES.OK, young.stderr)
  } finally { await r.server.close() }
})

test('arm (u): formula-leading WooCommerce text: the data file keeps it exactly, the inspection copy neutralises it, the provenance counts it', async (t) => {
  const parents = catalogue()
  parents[0].name = '=HYPERLINK("http://example.invalid","x")'
  parents[1].name = '-Spacer kit'
  parents[3].name = '-5V cable'
  const r = await rig({}, parents)
  try {
    assert.equal((await snapshot(r)).code, SNAPSHOT_EXIT_CODES.OK)
    const data = readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.variantParents), 'utf8')
    const inspect = readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.variantParentsInspection), 'utf8')
    const provenance = JSON.parse(readFileSync(path.join(r.out, SNAPSHOT_FILE_NAMES.provenance), 'utf8'))
    precondition(t, 'formula-leading cells counted', provenance.formulaLeadingCells)
    assert.equal(provenance.formulaLeadingCells, 4, 'three WIDGET rows carry the = title and the one GADGET row with a SKU carries -Spacer; the BIG rows with -5V are not formulas')
    assert.ok(data.includes('=HYPERLINK') && !data.includes("'=HYPERLINK"), 'the data file is untouched')
    assert.ok(inspect.includes("'=HYPERLINK") && inspect.includes("'-Spacer kit"), 'the inspection copy is neutralised')
    assert.ok(inspect.includes(',-5V cable,') && !inspect.includes("'-5V"), 'a name that merely starts with "-5" is not a formula')
  } finally { await r.server.close() }
})

test('arm (q4): a product listed but already gone (404 on its variations) abandons the round and the next round reads the real catalogue', async (t) => {
  const parents = catalogue()
  let fired = 0
  const r = await rig({
    pageSizeCap: 2,
    intercept: (c, res) => {
      if (c.route === 'products' && c.page === 1 && fired === 0) { fired++; parents.splice(0, 1); parents.push({ id: 500, sku: 'NEWEST', name: 'Added meanwhile', variations: [{ id: 5001, sku: 'N-01' }] }) }
      return res
    },
  }, parents)
  try {
    const ran = await snapshot(r)
    precondition(t, 'products deleted after being listed', fired)
    assert.equal(ran.code, SNAPSHOT_EXIT_CODES.OK, ran.stderr)
    assert.ok(r.server.requests.some((q) => q.status === 404), 'the walk really met the 404')
  } finally { await r.server.close() }
})
