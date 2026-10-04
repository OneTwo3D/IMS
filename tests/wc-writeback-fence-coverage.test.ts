import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * o3d-zvec.3 — THE BY-CONSTRUCTION HALF.
 *
 * The brief for the fence was "cover every writeback path, not the ones you happen to find".
 * Enumerating today's paths and fencing each one is the design that decays: the eleventh path,
 * added next month by somebody who has not read this, is unfenced and nothing notices until the
 * live store sends duplicate customer emails.
 *
 * So the fence sits in lib/connectors/woocommerce/transport.ts, and THIS file asserts the property
 * that makes that placement sufficient: no other file in the WooCommerce connector may hold the
 * raw HTTP client. A new writeback path therefore cannot reach WooCommerce except through the
 * fence, and one that tries fails this test rather than shipping.
 *
 * The check is an ABSENCE check over every file in the directory (universal), not a presence check
 * on the files it knows about (existential) — a new file is in scope automatically.
 *
 * WHAT WOULD STILL PASS THIS TEST: a path that reaches WooCommerce from OUTSIDE
 * lib/connectors/woocommerce/ — e.g. a server action calling `connectorFetch` at a WC URL itself.
 * The final test below bounds that: it asserts which files anywhere in the tree name a WC REST or
 * helper-plugin path, so a new one outside the connector shows up here.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONNECTOR_DIR = 'lib/connectors/woocommerce'

/** The ONE file permitted to import the raw HTTP client: the fence's own chokepoint. */
const CHOKEPOINT = `${CONNECTOR_DIR}/transport.ts`

const RAW_CLIENT_IMPORT_RE = /from\s+['"](?:@\/lib\/security\/connector-fetch|(?:\.\.\/)+security\/connector-fetch)['"]/
/** A bare `fetch(`/`globalThis.fetch` would bypass both the fence and the SSRF client. */
const BARE_FETCH_RE = /(?<![A-Za-z0-9_$.])fetch\s*\(|globalThis\.fetch|node-fetch|from\s+['"]undici['"]/

function listTsFiles(dir: string): string[] {
  const absolute = path.join(REPO_ROOT, dir)
  const out: string[] = []
  for (const entry of readdirSync(absolute)) {
    const relative = `${dir}/${entry}`
    if (statSync(path.join(REPO_ROOT, relative)).isDirectory()) {
      out.push(...listTsFiles(relative))
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(relative)
  }
  return out.sort()
}

/**
 * The pure evaluator, so the rig can be shown to FIND something before it is pointed at the real
 * tree. Returns the offending files rather than a boolean, because the failure message has to name
 * them.
 */
export function findUnfencedWcHttpFiles(
  files: Array<{ file: string; text: string }>,
  chokepoint: string,
): { rawClientImporters: string[]; bareFetchUsers: string[] } {
  const rawClientImporters: string[] = []
  const bareFetchUsers: string[] = []
  for (const { file, text } of files) {
    if (file === chokepoint) continue
    // Strip line comments so a file that DISCUSSES connector-fetch is not an offence; a real
    // import is a `from '...'` clause and cannot survive comment removal.
    const code = text.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '')
    if (RAW_CLIENT_IMPORT_RE.test(code)) rawClientImporters.push(file)
    if (BARE_FETCH_RE.test(code)) bareFetchUsers.push(file)
  }
  return { rawClientImporters, bareFetchUsers }
}

// ---------------------------------------------------------------------------
// First: prove the rig can find something
// ---------------------------------------------------------------------------

test('the rig detects an unfenced path — proven on fixtures before it is trusted on the tree', () => {
  const offenders = findUnfencedWcHttpFiles([
    {
      file: 'lib/connectors/woocommerce/sync/brand-new-writeback.ts',
      text: "import { connectorFetch } from '@/lib/security/connector-fetch'\nawait connectorFetch(url, { method: 'POST' }, { connectorName: 'WooCommerce' })\n",
    },
    {
      file: 'lib/connectors/woocommerce/sync/relative-import.ts',
      text: "import { connectorFetch } from '../../security/connector-fetch'\n",
    },
    {
      file: 'lib/connectors/woocommerce/sync/bare-fetch.ts',
      text: "const res = await fetch(`${url}/wp-json/wc/v3/orders/1`, { method: 'PUT' })\n",
    },
    {
      file: 'lib/connectors/woocommerce/sync/innocent.ts',
      text: "import { wooCommerceConnectorFetch } from '../transport'\n// connectorFetch is not imported here\n",
    },
    {
      file: 'lib/connectors/woocommerce/transport.ts',
      text: "import { connectorFetch } from '@/lib/security/connector-fetch'\n",
    },
  ], 'lib/connectors/woocommerce/transport.ts')

  assert.deepEqual(offenders.rawClientImporters, [
    'lib/connectors/woocommerce/sync/brand-new-writeback.ts',
    'lib/connectors/woocommerce/sync/relative-import.ts',
  ])
  assert.deepEqual(offenders.bareFetchUsers, ['lib/connectors/woocommerce/sync/bare-fetch.ts'])
})

// ---------------------------------------------------------------------------
// Then: the real tree
// ---------------------------------------------------------------------------

test('transport.ts is the ONLY file in the WooCommerce connector holding the raw HTTP client', () => {
  const files = listTsFiles(CONNECTOR_DIR)
  assert.ok(files.length >= 15, `precondition: the walk reached the connector (found ${files.length} files)`)
  assert.ok(files.includes(CHOKEPOINT), `precondition: the chokepoint exists (${files.length} files scanned)`)
  console.log(`[wc-writeback-fence-coverage] scanned ${files.length} files under ${CONNECTOR_DIR}`)

  const offenders = findUnfencedWcHttpFiles(
    files.map((file) => ({ file, text: readFileSync(path.join(REPO_ROOT, file), 'utf8') })),
    CHOKEPOINT,
  )

  assert.deepEqual(
    offenders.rawClientImporters,
    [],
    `these files bypass the writeback fence by importing the raw HTTP client; route them through ${CHOKEPOINT} instead`,
  )
  assert.deepEqual(
    offenders.bareFetchUsers,
    [],
    `these files bypass both the writeback fence and the SSRF client with a bare fetch(); use wooCommerceConnectorFetch`,
  )
})

test('the chokepoint really evaluates the fence — not merely a file named transport.ts', () => {
  const text = readFileSync(path.join(REPO_ROOT, CHOKEPOINT), 'utf8')
  assert.match(text, /evaluateWcWritebackFence/, 'the transport must consult the fence')
  assert.match(text, /isWcWritebackMutation/, 'and must decide on the request method')
  assert.match(text, /logActivity/, 'and must record a refusal where an operator can see it')
  assert.match(text, /throw new WooCommerceWritebackRefusedError/, 'and must fail closed')
})

/**
 * Files OUTSIDE lib/connectors/woocommerce/ that name a WooCommerce endpoint path, pinned.
 *
 * The fence lives at the connector's transport, so a WooCommerce request built anywhere else is
 * outside it. Today exactly one such caller exists and it is a READ; it is pinned here with the
 * reason, so a NEW one — or a write added to this one — fails this test instead of shipping
 * unfenced. This is the honest boundary of the "by construction" claim.
 */
const KNOWN_ENDPOINT_HOLDERS_OUTSIDE_CONNECTOR: Record<string, string> = {
  'scripts/record-connection-tests.ts':
    'Operator CLI that GETs one WooCommerce setting to record a connection test. Read-only: no '
    + 'mutating method, so the writeback fence does not apply. It also bypasses connectorFetch '
    + '(bare fetch) — tracked separately, not a writeback path.',
}

const MUTATING_METHOD_RE = /method:\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]/i

test('every WooCommerce WRITE path in the tree is inside the fenced connector', () => {
  const scanDirs = ['app', 'lib', 'scripts', 'components']
  const holders: string[] = []
  const writesOutside: string[] = []
  let scanned = 0
  for (const dir of scanDirs) {
    for (const file of listTsFiles(dir)) {
      scanned += 1
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      // Comments mention `/wp-json/` while explaining URL shapes; a comment builds no request.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (!/wp-json\/(?:wc\/v3|oti\/v1)/.test(code)) continue
      holders.push(file)
      if (file.startsWith(`${CONNECTOR_DIR}/`)) continue
      if (MUTATING_METHOD_RE.test(code)) writesOutside.push(file)
    }
  }
  assert.ok(scanned > 500, `precondition: the walk covered the application (scanned ${scanned} files)`)
  assert.ok(holders.length > 0, 'precondition: the scan found the WooCommerce endpoint builders at all')
  console.log(`[wc-writeback-fence-coverage] ${scanned} files scanned, ${holders.length} build a WooCommerce endpoint path`)

  assert.deepEqual(
    writesOutside,
    [],
    'these files send a MUTATING WooCommerce request from outside the fenced connector; move the call '
    + 'into lib/connectors/woocommerce/ so it passes through transport.ts',
  )

  const unpinned = holders
    .filter((file) => !file.startsWith(`${CONNECTOR_DIR}/`))
    .filter((file) => !(file in KNOWN_ENDPOINT_HOLDERS_OUTSIDE_CONNECTOR))
  assert.deepEqual(
    unpinned,
    [],
    'a new file outside the WooCommerce connector builds a WooCommerce endpoint URL. If it writes, move '
    + 'it inside the connector; if it only reads, add it to KNOWN_ENDPOINT_HOLDERS_OUTSIDE_CONNECTOR with '
    + 'the reason.',
  )

  // And the pin must not rot: a pinned entry that no longer holds an endpoint path is deleted.
  const stale = Object.keys(KNOWN_ENDPOINT_HOLDERS_OUTSIDE_CONNECTOR).filter((file) => !holders.includes(file))
  assert.deepEqual(stale, [], 'these pinned exemptions no longer build a WooCommerce endpoint path; delete them')
})
