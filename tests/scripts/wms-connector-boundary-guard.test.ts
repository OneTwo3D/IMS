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

// ---------------------------------------------------------------------------------------------
// ROUND 6, HIGH 2 — A LEAF TOKEN IS INSPECTED ON ITS OWN, SO AN ID CAN BE SPELLED BETWEEN TOKENS.
//
// Round 4's parse-tree rewrite scans every leaf token's SOURCE TEXT. `'mint' + 'soft'` is two
// tokens, neither of which contains `mintsoft`; `'\x6dintsoft'` is one token whose text spells
// `\x6dintsoft` and whose VALUE is the id. Both exited 0 with a live connector literal in a
// protected generic file. The guard now folds CONSTANT STRING EXPRESSIONS and matches the value.
//
// The negatives matter as much as the positives here: a fold that fired on every concatenation
// would pass all of the cases below and be unusable.
// ---------------------------------------------------------------------------------------------

test('guard: a connector id CONCATENATED from two literals fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/concat-leak.ts': "export const active = 'mint' + 'soft'\n",
  })
  assert.equal(run.status, 1, 'neither token contains the id; the VALUE is the id')
  assert.match(run.stderr, /lib\/domain\/wms\/concat-leak\.ts:1/)
})

test('guard: a MULTI-PART concatenation of literals fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/multi-concat-leak.ts': "export const active = 'mi' + 'nt' + 'so' + 'ft'\n",
  })
  assert.equal(run.status, 1, 'the fold must walk the whole left-associative tree, not just one pair')
  assert.match(run.stderr, /lib\/domain\/wms\/multi-concat-leak\.ts:1/)
})

test('guard: an ESCAPED-CHARACTER spelling of a connector id fails', (t) => {
  const run = runGuard(t, {
    // The token's source text is `'\x6dintsoft'`; only its cooked value is the id.
    'lib/domain/wms/escape-leak.ts': "export const active = '\\x6dint\\u0073oft'\n",
  })
  assert.equal(run.status, 1, 'the raw token text does not contain the id; the cooked value does')
  assert.match(run.stderr, /lib\/domain\/wms\/escape-leak\.ts:1/)
})

test('guard: NO-SUBSTITUTION TEMPLATE literals concatenated into a connector id fail', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/tpl-concat-leak.ts': 'export const active = `mint` + `soft`\n',
  })
  assert.equal(run.status, 1, 'a backtick literal folds to its text like a quoted one')
  assert.match(run.stderr, /lib\/domain\/wms\/tpl-concat-leak\.ts:1/)
})

test('guard: a template whose SUBSTITUTION is itself constant fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/tpl-span-leak.ts': "export const active = `mint${'soft'}`\n",
  })
  assert.equal(run.status, 1, 'the head and the span are separate tokens; the value is the id')
  assert.match(run.stderr, /lib\/domain\/wms\/tpl-span-leak\.ts:1/)
})

test('guard: a concatenation that does NOT form a connector id is clean', (t) => {
  // The whole point of folding rather than rejecting: `'mint' + 'age'` is `mintage`, which is not
  // an id and must not be reported. A guard that fires on every `+` is noise, and noise is how a
  // guard gets allowlisted into silence.
  const run = runGuard(t, {
    'lib/domain/wms/harmless-concat.ts': [
      "export const label = 'mint' + 'age'",
      "export const path = 'orders' + '/' + 'sync'",
      "export const list = ['a', 'b'].join(', ')",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /boundary clean/)
})

test('guard: an id assembled through in-file CONSTS fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/const-leak.ts': [
      "const head = 'mint'",
      "const tail = 'soft'",
      'export const active = head + tail',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1, 'a const initializer is a constant expression the runtime folds too')
  // Blamed on the piece that supplied the match, so a per-line waiver still lands where the text is.
  assert.match(run.stderr, /lib\/domain\/wms\/const-leak\.ts:1/)
})

test('guard: an id assembled from ENUM members fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/enum-leak.ts': [
      "enum Part { Head = 'mint', Tail = 'soft' }",
      'export const active = Part.Head + Part.Tail',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1, 'a string enum member is a constant')
})

test('guard: an id assembled by ARRAY.JOIN of literals fails', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/join-leak.ts': "export const active = ['mint', 'soft'].join('')\n",
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /lib\/domain\/wms\/join-leak\.ts:1/)
})

test('guard: an id assembled by String.fromCharCode fails', (t) => {
  const run = runGuard(t, {
    // 'mintsoft', one code unit at a time. No literal in the file contains any of it.
    'lib/domain/wms/charcode-leak.ts':
      'export const active = String.fromCharCode(109, 105, 110, 116, 115, 111, 102, 116)\n',
  })
  assert.equal(run.status, 1, 'the characters are minted; nothing for a text scan to find')
  assert.match(run.stderr, /lib\/domain\/wms\/charcode-leak\.ts:1/)
})

test('guard: a concatenation with an UNKNOWN operand between two id fragments fails', (t) => {
  // The hole is read as possibly-empty, which is the strict reading of an operand the guard
  // cannot evaluate: at runtime `suffix` may be ''.
  const run = runGuard(t, {
    'lib/domain/wms/hole-leak.ts': [
      'export function idFor(suffix: string): string {',
      "  return 'mint' + suffix + 'soft'",
      '}',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /lib\/domain\/wms\/hole-leak\.ts:2/)
})

test('guard: an UNFOLDABLE empty-separator join is REJECTED rather than passed', (t) => {
  // The conservative half. The elements are out of view and the separator glues, so the guard
  // cannot rule out an id and refuses to say "clean" about it.
  const run = runGuard(t, {
    'lib/domain/wms/opaque-join.ts': [
      'export function assemble(parts: string[]): string {',
      "  return parts.join('')",
      '}',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1, 'a construct that can glue unseen fragments must not exit 0 silently')
  assert.match(run.stderr, /cannot evaluate and cannot bound/)
})

test('guard: a join whose separator cannot GLUE an id is clean', (t) => {
  // The other side of the same rule, and what keeps the reject usable: no connector id contains
  // `, `, so joining unknown elements with it cannot build one out of pieces that are not ids.
  const run = runGuard(t, {
    'lib/domain/wms/safe-join.ts': [
      'export function assemble(parts: string[]): string {',
      "  return parts.join(', ')",
      '}',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: String.fromCharCode too SHORT to spell an id is clean', (t) => {
  // `mintsoft` is eight characters; one argument cannot produce eight. Bounding the length is what
  // keeps four honest call sites in this repo (a flag emoji, a RESP type byte, an entity decode)
  // out of the reject path.
  const run = runGuard(t, {
    'lib/domain/wms/short-charcode.ts': [
      'export function typeByte(buffer: Buffer, offset: number): string {',
      '  return String.fromCharCode(buffer[offset])',
      '}',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a SPREAD into String.fromCharCode is rejected — the bound is gone', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/spread-charcode.ts': [
      'export function decode(codes: number[]): string {',
      '  return String.fromCharCode(...codes)',
      '}',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1, 'a spread can carry eight code points as easily as one')
  assert.match(run.stderr, /cannot evaluate and cannot bound/)
})

test('guard: a folded finding is BLAMED on the piece that supplied it, so waivers still land', (t) => {
  // A long concatenation carries the id in one of its middle literals. The finding must be
  // reported against THAT line — not the line the expression starts on — or every per-line waiver
  // already in the tree silently stops applying. app/api/backup/restore/route.ts is exactly this
  // shape and is waived on the fragment's own line.
  const run = runGuard(t, {
    'lib/domain/wms/blame.ts': [
      "export const notice = 'a long operator-facing sentence '",
      "  + 'that mentions mintsoft in its middle clause '",
      "  + 'and then carries on for a while afterwards'",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /lib\/domain\/wms\/blame\.ts:2/, 'blamed on the fragment, not on line 1')
  assert.doesNotMatch(run.stderr, /blame\.ts:1/)
})

test('guard: a waiver above the BLAMED line suppresses a folded finding', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/blame-waived.ts': [
      "export const notice = 'a long operator-facing sentence '",
      '  // wms-connector-boundary-ok: o3d-test: prose, not dispatch',
      "  + 'that mentions mintsoft in its middle clause '",
      "  + 'and then carries on afterwards'",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: the fold also reaches CORE flows, which are scanned raw', (t) => {
  // Outside the generic layer the scan is a raw line read, and a raw line read misses
  // `'mint' + 'soft'` for exactly the same reason the token scan does. The fold is additive in
  // BOTH paths, or half the tree keeps the hole.
  const run = runGuard(t, {
    'lib/domain/sales/order-service.ts': "export const wms = 'mint' + 'soft'\n",
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /lib\/domain\/sales\/order-service\.ts:1/)
})

test('guard: an allowlisted file may still assemble its own id', (t) => {
  const run = runGuard(t, {
    'lib/connectors/mintsoft/client.ts': "export const id = 'mint' + 'soft'\n",
  })
  assert.equal(run.status, 0, run.stderr)
})

// ---------------------------------------------------------------------------------------------
// o3d-lhjh / o3d-remove-shiphero round 8 (Codex HIGH 3) — THE FOUR SPELLINGS THE ROUND-6 FOLD
// EXITED 0 ON, and the negatives that keep the new rules usable.
//
// Each of the first four was run against the shipped guard before the fix and printed "clean".
// ---------------------------------------------------------------------------------------------

test('guard: a NUMERIC-arithmetic String.fromCharCode spelling fails', (t) => {
  // THE ROUND-6 DEFECT IN ONE LINE. Every binary `+` was folded as string concatenation, so
  // `100+9` became `'1009'` — a valid, out-of-range-ish code point that produced an unrelated
  // character — and the fold reported EXACT. Not "cannot evaluate" (which is reported) but
  // "evaluated, confidently, to the wrong value" (which is not).
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts':
      'export const id = String.fromCharCode(100+9,100+5,100+10,100+16,100+15,100+11,100+2,100+16)\n',
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /lib\/domain\/wms\/sweep\.ts:1/)
})

test('guard: arithmetic that is NOT a spelling stays clean', (t) => {
  // The negative for the rule above. Making `+` arithmetic-aware must not make ordinary numbers a
  // finding, and `fromCharCode` over real character codes must still evaluate to what it evaluates
  // to — a guard that fired on every sum would be turned off within a week.
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts': [
      'export const batch = 100 + 9',
      'export const window = (60 * 60 * 1000) - 250',
      'export const initials = String.fromCharCode(65, 66, 67)',
      'export const shifted = String.fromCharCode(0x41 + 1)',
      // An unknown operand reads as the empty string in a `+`, so it must read the same way through
      // a `.toString()` on the result. Rejecting one and not the other is the inconsistency that
      // gets a guard allowlisted into silence.
      'declare const offset: number',
      'export const page = (offset + 1).toString()',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a connector id CONCATENATED ACROSS MODULES fails', (t) => {
  // The fold used to be bound to ONE file and read an unresolvable operand as the empty string, so
  // splitting the id over two files was enough: `'mint'` is not an id, and the other half lived in
  // a module the guard never opened. It now follows repo imports and evaluates the whole thing.
  const run = runGuard(t, {
    'lib/domain/wms/parts.ts': "export const SOFT = 'soft'\n",
    'lib/domain/wms/sweep.ts': "import { SOFT } from './parts'\nexport const id = 'mint' + SOFT\n",
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /lib\/domain\/wms\/sweep\.ts:2/)
})

test('guard: the same concatenation through an `@/` import and a NAMESPACE import fails', (t) => {
  const run = runGuard(t, {
    'lib/connectors/mintsoft/ids.ts': "export const TAIL = 'soft'\n",
    'lib/domain/wms/a.ts': "import { TAIL } from '@/lib/connectors/mintsoft/ids'\nexport const a = 'mint' + TAIL\n",
    'lib/domain/wms/b.ts': "import * as ids from '@/lib/connectors/mintsoft/ids'\nexport const b = `mint${ids.TAIL}`\n",
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /lib\/domain\/wms\/a\.ts:2/)
  assert.match(run.stderr, /lib\/domain\/wms\/b\.ts:2/)
})

test('guard: a repo import it CANNOT follow to a constant is a finding, not an empty string', (t) => {
  // The rule that makes cross-module folding sound rather than best-effort: an operand the guard
  // knows is a CONSTANT EXPRESSION but cannot evaluate is reported. Reading it as empty is what
  // let the split spelling through in the first place.
  const run = runGuard(t, {
    'lib/domain/wms/parts.ts': 'export function tail() { return String(Date.now()) }\n',
    'lib/domain/wms/sweep.ts': "import { tail } from './parts'\nexport const id = 'prefix-' + tail\n",
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /lib\/domain\/wms\/sweep\.ts:2/)
})

test('guard: a cross-module constant that does not spell an id is clean', (t) => {
  // The negative for cross-module folding: following imports must ANSWER questions, not raise them.
  const run = runGuard(t, {
    'lib/domain/wms/parts.ts': "export const PREFIX = 'wms'\nexport const LIMIT = 100\n",
    'lib/domain/wms/sweep.ts': [
      "import { LIMIT, PREFIX } from './parts'",
      "export const label = PREFIX + '-sweep'",
      'export const page = LIMIT + 1',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a PACKAGE import is not followed and is not reported', (t) => {
  // node_modules is not scanned at all, so demanding evaluability of a package import would be the
  // guard requiring of third-party code a property it never checks — and would fire on `path.sep`
  // in every file that builds a filesystem path.
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts': [
      "import path from 'node:path'",
      "import { randomUUID } from 'node:crypto'",
      "export const dir = 'wms' + path.sep",
      "export const ref = 'ref-' + randomUUID()",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a CONSTANT put through .replace is REJECTED rather than passed', (t) => {
  // `'mintXsoft'.replace('X','')` — no token contains the id and the round-6 fold modelled no
  // `.replace`, so it folded to nothing at all. Modelling `.replace` would close one member of an
  // unbounded family (`.padStart`, `.normalize`, `.split().reverse().join()`, …), so the rule is
  // about the SHAPE: a constant string through an operation the guard cannot evaluate is a finding.
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts': "export const id = 'mintXsoft'.replace('X', '')\n",
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /cannot evaluate/)
})

test('guard: the same method on a RUNTIME value is clean', (t) => {
  // The negative that keeps the rule above usable. Ordinary code transforms data, not literals —
  // the receiver does not fold, so nothing here is a constant the guard has failed to evaluate.
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts': [
      'export function normalise(input: string, pad: string) {',
      "  return input.replace(/\\s+/g, ' ').padStart(8, pad).split(',').map((s) => s.trim())",
      '}',
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a base64 Buffer.from spelling fails', (t) => {
  // `atob` has been modelled since round 6; `Buffer.from(x, 'base64')` is the same operation under
  // another name, and it was not. It is EXACTLY evaluable, so it is evaluated — and this one
  // evaluates to the connector id.
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts': "export const id = Buffer.from('bWludHNvZnQ=', 'base64').toString('utf8')\n",
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /lib\/domain\/wms\/sweep\.ts:1/)
})

test('guard: an ordinary Buffer.from of a non-id constant, and of runtime data, is clean', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts': [
      "export const seed = Buffer.from('c3dlZXA=', 'base64').toString('utf8')",
      "export const digest = (body: string) => Buffer.from(body, 'utf8').toString('hex')",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: a Buffer.from of a constant in an encoding it cannot evaluate is REJECTED', (t) => {
  const run = runGuard(t, {
    'lib/domain/wms/sweep.ts': [
      'declare const enc: BufferEncoding',
      "export const decoded = Buffer.from('bWludHNvZnQ=', enc).toString('utf8')",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /cannot evaluate/)
})

test('guard: a Buffer constant EXPORTED from one module and decoded in another fails', (t) => {
  // o3d-remove-shiphero round 10, Codex HIGH 3. `foldImported` copied `exact`, `opaque` and
  // `numeric` out of the remote fold by NAME and dropped `binary` — the flag that says "these
  // pieces are BYTES in latin1, re-encode them before reading them as a string". So the importing
  // file's `.toString('utf16le')` took the latin1 spelling at face value, kept the interleaved
  // NULs, matched nothing, and the guard exited 0 over a value that is the connector id at runtime.
  //
  // Splitting it across two files was the whole exploit: the SAME expression in one file has always
  // failed (see the base64 case above), so this is not a new spelling, it is one already closed
  // arriving through a module boundary.
  const run = runGuard(t, {
    'lib/domain/wms/parts.ts': "export const BYTES = Buffer.from('bQBpAG4AdABzAG8AZgB0AA==', 'base64')\n",
    'lib/domain/wms/sweep.ts': "import { BYTES } from './parts'\nexport const id = BYTES.toString('utf16le')\n",
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /lib\/domain\/wms\/sweep\.ts:2/)
})

test('guard: the same cross-module Buffer in HEX, through a namespace import, fails', (t) => {
  // A second encoding and a second import spelling, because one passing case is a coincidence.
  //
  // THE FIRST DRAFT OF THIS CASE WAS VACUOUS, and the mutation run is what showed it: it used
  // `Buffer.from('6d696e74736f6674','hex').toString('utf8')`, whose latin1 byte spelling ALREADY
  // reads `mintsoft`. So it passed with the `binary` flag dropped and proved only that imports are
  // followed — a property two earlier cases already cover. The bytes here are `mintsoft` in
  // UTF-16LE, whose latin1 spelling is NUL-interleaved and matches nothing: the finding depends on
  // the flag surviving the module boundary and on nothing else.
  const run = runGuard(t, {
    'lib/domain/wms/parts.ts': "export const HEX = Buffer.from('6d0069006e00740073006f0066007400', 'hex')\n",
    'lib/domain/wms/sweep.ts': "import * as p from './parts'\nexport const id = p.HEX.toString('utf16le')\n",
  })
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /lib\/domain\/wms\/sweep\.ts:2/)
})

test('guard: a cross-module Buffer constant that does not spell an id is clean', (t) => {
  // The negative the two above are worthless without. Carrying `binary` across the boundary must
  // make the guard EVALUATE the bytes, not flag every re-exported Buffer — a rule that fires on
  // ordinary code is a rule that gets allowlisted into silence.
  const run = runGuard(t, {
    'lib/domain/wms/parts.ts': "export const BYTES = Buffer.from('c3dlZXA=', 'base64')\n",
    'lib/domain/wms/sweep.ts': [
      "import { BYTES } from './parts'",
      "export const seed = BYTES.toString('utf8')",
      "export const wide = BYTES.toString('utf16le')",
      '',
    ].join('\n'),
  })
  assert.equal(run.status, 0, run.stderr)
})

test('guard: an import CYCLE terminates instead of recursing', (t) => {
  // Cross-module folding walks a graph, and the graph in this repo has cycles. A guard that hangs
  // or blows the stack on one is a guard that gets removed from `check:all`.
  const run = runGuard(t, {
    'lib/domain/wms/a.ts': "import { B } from './b'\nexport const A = B + 'a'\n",
    'lib/domain/wms/b.ts': "import { A } from './a'\nexport const B = A + 'b'\n",
  })
  assert.notEqual(run.status, -1, 'the guard terminated')
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stderr, /cannot evaluate/)
})
