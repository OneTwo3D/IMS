/**
 * PROOF THAT THE WMS CONNECTOR-BOUNDARY GUARD CAN FAIL (o3d-remove-shiphero round 4, Codex HIGH 3 + 4).
 *
 * WHY THIS FILE EXISTS. `scripts/check-wms-connector-boundary.mjs` is believed: `npm run check:all`
 * runs it, it prints "clean", and nobody re-reads it. Rounds 2 and 3 shipped a version that COULD
 * NOT FAIL on three real inputs — a connector literal inside a regex literal, one inside JSX text,
 * and a registered id the guard's own id-scraper had silently dropped — and in each case it printed
 * "clean" while the literal sat in a protected file. A guard nobody has watched fail is a guard
 * nobody has tested; it is an assertion about itself.
 *
 * So every case below runs the REAL script, as `check:all` runs it, against a throwaway tree, and
 * asserts the EXIT CODE. The negative cases matter as much as the positive ones: a guard that fails
 * on everything would pass this file's positives and be just as useless.
 *
 * THE TREE IS FAKE, THE SCRIPT IS NOT. `ROOT` is `process.cwd()`, so pointing the child process at
 * a temp directory containing a `lib/connectors/wms/types.ts` and a few files is enough to exercise
 * id resolution, the allowlist, the comment narrowing and the parse-tree scan without touching the
 * repo.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createTempDirSync } from './temp-dir.ts'

const GUARD = resolve(process.cwd(), 'scripts/check-wms-connector-boundary.mjs')

/** The shipped id list, as the guard must resolve it. */
const ONE_ID_LIST = "export const WMS_CONNECTOR_IDS = ['mintsoft'] as const\n"

type GuardRun = { status: number; stdout: string; stderr: string }

/**
 * Lay `files` down in a throwaway tree and run the guard there.
 *
 * `lib/connectors/wms/types.ts` is written for you unless `files` provides its own — every case
 * needs one, and most of them need the ordinary one.
 */
function runGuard(t: TestContext, files: Record<string, string>): GuardRun {
  const root = createTempDirSync('wms-boundary-guard-', t)
  const tree = { 'lib/connectors/wms/types.ts': ONE_ID_LIST, ...files }
  for (const [relPath, contents] of Object.entries(tree)) {
    const full = join(root, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  const result = spawnSync(process.execPath, [GUARD], { cwd: root, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// ---------------------------------------------------------------------------------------------
// The baseline: the guard passes a tree with nothing wrong in it.
// ---------------------------------------------------------------------------------------------

test('guard: a generic-layer file with no connector literal is clean', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/plain.ts': 'export const sweepBatchSize = 50\n',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /boundary clean/)
})

// ---------------------------------------------------------------------------------------------
// The earlier positives, re-confirmed on the rewritten guard.
// ---------------------------------------------------------------------------------------------

test('guard: a connector literal in generic-layer CODE fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/leak.ts': "export const active = 'mintsoft'\n",
  })
  assert.equal(run.status, 1, 'a live literal in a protected generic file must fail the build')
  assert.match(run.stderr, /lib\/domain\/wms\/leak\.ts:1/)
})

test('guard: the same word in a COMMENT in the generic layer is NOT a finding', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/prose.ts': [
      '/**',
      " * Mintsoft's Order/List caps Limit at 100 — which is why this clamps rather than defaults.",
      ' */',
      '// mintsoft taught us this rule; it is not pinned to it.',
      'export const pageLimit = 100 /* mintsoft rejects 101 */',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a per-line waiver suppresses a finding', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/waived.ts': [
      '// wms-connector-boundary-ok: o3d-test: the fixture for the waiver path',
      "export const active = 'mintsoft'",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: an allowlisted path may name the connector in code', (t) => {
  const run = runGuard(t, {
    'lib/connectors/mintsoft/client.ts': "export const id = 'mintsoft'\n",
  })
  assert.equal(run.status, 0, run.stderr)
})

// ---------------------------------------------------------------------------------------------
// HIGH 3 — the two inputs the hand-rolled tokenizer went BLIND on.
//
// Both begin with `//` in a position the old character state machine read as "line comment
// starts here". It blanked the rest of the line, reached the newline in a normal state, and so
// never tripped the "mis-parse → scan raw" fallback its own header promised. Exit 0, literal
// live, in a protected file.
// ---------------------------------------------------------------------------------------------

test('guard: a connector literal inside a REGEX LITERAL fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/regex-leak.ts': 'export const r = /[//]mintsoft/\nexport const hit = (s: string) => r.test(s)\n',
  })
  assert.equal(run.status, 1, 'a regex literal is code; the old tokenizer read `//` inside it as a comment')
  assert.match(run.stderr, /lib\/domain\/wms\/regex-leak\.ts:1/)
})

test('guard: a connector literal inside JSX TEXT fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/panel.tsx': [
      'export function Panel() {',
      '  return <div>https://mintsoft</div>',
      '}',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1, 'JSX text is code; the old tokenizer read the `//` in the URL as a comment')
  assert.match(run.stderr, /lib\/domain\/wms\/panel\.tsx:2/)
})

test('guard: a connector literal inside a TEMPLATE literal fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/tpl-leak.ts': 'export const key = (n: string) => `mintsoft_${n}`\n',
  })
  assert.equal(run.status, 1, 'a template chunk is code')
  assert.match(run.stderr, /lib\/domain\/wms\/tpl-leak\.ts:1/)
})

// ---------------------------------------------------------------------------------------------
// HIGH 4 — the id list must RESOLVE, in full, or the guard must refuse to run.
// ---------------------------------------------------------------------------------------------

test('guard: an id list with a NON-LITERAL element is a hard failure, not a short list', (t) => {
  const run = runGuard(t, {
    'lib/connectors/wms/types.ts':
      "import { ACME_WMS_ID } from './acme'\nexport const WMS_CONNECTOR_IDS = ['mintsoft', ACME_WMS_ID] as const\n",
    // The registered connector the old scraper dropped. Under the old guard this tree exited 0.
    'lib/domain/wms/acme-leak.ts': "export const active = 'acme-wms'\n",
  })
  assert.notEqual(run.status, 0, 'an id the guard cannot resolve must stop the run, not shrink the scan')
  assert.match(run.stderr, /does not resolve to a string literal/)
  assert.match(run.stderr, /ACME_WMS_ID/)
})

test('guard: an id containing a REGEX METACHARACTER still matches its own literal', (t) => {
  const run = runGuard(t, {
    'lib/connectors/wms/types.ts': "export const WMS_CONNECTOR_IDS = ['acme+wms'] as const\n",
    'lib/domain/wms/plus-leak.ts': "export const active = 'acme+wms'\n",
  })
  assert.equal(run.status, 1, 'the old guard interpolated ids into a regex unescaped, so `+` matched nothing')
  assert.match(run.stderr, /lib\/domain\/wms\/plus-leak\.ts:1/)
})

test('guard: an id containing a regex metacharacter does NOT match what the regex would have', (t) => {
  // The other half of the escaping bug: unescaped, `acme+wms` is the pattern "acme, one or more
  // times, then wms", which matches `acmewms` — a word that is not a connector id. A guard that
  // fires on the wrong string is noise, and noise is how a guard gets allowlisted into silence.
  const run = runGuard(t, {
    'lib/connectors/wms/types.ts': "export const WMS_CONNECTOR_IDS = ['acme+wms'] as const\n",
    'lib/domain/wms/not-a-leak.ts': "export const unrelated = 'acmewms'\n",
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a types.ts with no WMS_CONNECTOR_IDS at all is a hard failure', (t) => {
  const run = runGuard(t, {
    'lib/connectors/wms/types.ts': 'export type WmsConnectorId = string\n',
    'lib/domain/wms/leak.ts': "export const active = 'mintsoft'\n",
  })
  assert.notEqual(run.status, 0, 'an unresolvable id list must never degrade to an empty scan')
  assert.match(run.stderr, /WMS_CONNECTOR_IDS/)
})

test('guard: an EMPTY id list is a hard failure', (t) => {
  const run = runGuard(t, {
    'lib/connectors/wms/types.ts': 'export const WMS_CONNECTOR_IDS = [] as const\n',
  })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /zero ids/)
})

// ---------------------------------------------------------------------------------------------
// The fail-safe direction: a file the parser cannot make sense of is scanned RAW (stricter),
// never skipped.
// ---------------------------------------------------------------------------------------------

test('guard: a generic-layer file that does not parse is scanned RAW, comments included', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/broken.ts': "const unterminated = 'oops\n// mintsoft\n",
  })
  assert.equal(run.status, 1, 'a mis-parse must make the guard stricter, never blinder')
  assert.match(run.stderr, /lib\/domain\/wms\/broken\.ts/)
})

test('guard: outside the generic layer, a connector literal in a COMMENT is a finding', (t) => {
  // Core flows are scanned whole. A core file has no business naming a warehouse at all, so the
  // comment narrowing stops at the WMS layer's edge.
  const run = runGuard(t, {
    'lib/domain/sales/order-service.ts': '// mintsoft used to be special-cased here\nexport const x = 1\n',
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /lib\/domain\/sales\/order-service\.ts:1/)
})
