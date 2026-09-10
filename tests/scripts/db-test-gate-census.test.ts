import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * THE FOUR WAYS INTO `scripts/check-db-test-gates.mjs`, EACH AS A TEST (o3d-n3yt r20, Codex r19).
 *
 * The census exists so that a `RUN_DB_*` gate cannot arrive in `tests/db/` wired to nothing and
 * report `# SKIP` inside a green CI run. Codex r19 found FOUR ways to satisfy it while nothing ran,
 * and they were one lesson: it enumerated the shapes its author had thought of and PASSED everything
 * else, while its single non-vacuity check ("some gate was found") stayed satisfied by the one gate
 * that was already known — so it reported healthy precisely when it was blind.
 *
 * These tests are that lesson, made executable. Each builds a throwaway repository containing the
 * exact shape Codex named and requires the census to EXIT NON-ZERO on it. The first test is the
 * control: the same fixture, correctly wired, must exit ZERO — without it, every assertion below
 * would be satisfied by a census that simply always fails.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CENSUS = path.join(REPO_ROOT, 'scripts', 'check-db-test-gates.mjs')

/** The npm script shape a correctly wired suite has: gates set, and a real Node test runner. */
const WIRED_SCRIPT = 'RUN_DB_FIXTURE_TESTS=1 REQUIRE_DB_FIXTURE_TESTS=1 node --test "tests/db/**/*.test.ts"'

/** A test file gated on `RUN_DB_<name>` in the ONE shape the census models, tripwire and all. */
function gatedFile(name: string): string {
  return [
    "import test from 'node:test'",
    `const skip = process.env.RUN_DB_${name} !== '1'`,
    `if (skip && process.env.REQUIRE_DB_${name} === '1') {`,
    `  throw new Error('REQUIRE_DB_${name}=1 but RUN_DB_${name} is not 1')`,
    '}',
    "test('the gated probe', { skip }, () => {})",
    '',
  ].join('\n')
}

/**
 * A repository with a package.json, an allowlist and some test files, and the census run over it.
 * `--root` is the only thing that makes this possible: the census resolves everything else itself.
 */
function census(
  files: Record<string, string>,
  options: { script?: string; allowlist?: Record<string, { reason: string }>; env?: Record<string, string> } = {},
): { status: number | null; output: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'db-test-gate-fixture-'))
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, scripts: { 'test:db': options.script ?? WIRED_SCRIPT } }, null, 2)}\n`,
    )
    mkdirSync(path.join(root, 'scripts'), { recursive: true })
    writeFileSync(
      path.join(root, 'scripts', 'db-test-gate-allowlist.json'),
      `${JSON.stringify(options.allowlist ?? {}, null, 2)}\n`,
    )
    for (const [rel, contents] of Object.entries(files)) {
      const target = path.join(root, rel)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, contents)
    }
    const result = spawnSync(process.execPath, [CENSUS, '--root', root], {
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, ...(options.env ?? {}) },
    })
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// THE CONTROL. Everything below asserts a non-zero exit; this is what stops that being vacuous.
// ---------------------------------------------------------------------------------------------

test('a correctly wired suite PASSES, so the refusals below are refusals and not a census that always fails', () => {
  const { status, output } = census({ 'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS') })
  assert.equal(status, 0, `expected a clean census, got:\n${output}`)
  assert.match(output, /census OK/)
})

// ---------------------------------------------------------------------------------------------
// HIGH 2 — computed and delegated env gates passed unseen.
// ---------------------------------------------------------------------------------------------

test('r19 HIGH: a gate read under a COMPUTED key fails the census instead of contributing nothing', () => {
  // Codex r19, verbatim: `const gate = 'RUN_DB_NEW'; process.env[gate]`. Under r19 this contributed
  // no gate at all, and the already-known retention gate kept the "some gate was found" counter
  // nonzero, so the census passed while the new test skipped in silence.
  const { status, output } = census({
    'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
    'tests/db/computed.test.ts': [
      "import test from 'node:test'",
      "const gate = 'RUN_DB_COMPUTED_TESTS'",
      "const skip = process.env[gate] !== '1'",
      "test('computed', { skip }, () => {})",
      '',
    ].join('\n'),
  })
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /tests\/db\/computed\.test\.ts:3:\d+ reads process\.env under the COMPUTED key/)
  // And the bare name is caught a second time, independently of where it is used.
  assert.match(output, /tests\/db\/computed\.test\.ts:2:\d+ names the gate RUN_DB_COMPUTED_TESTS as a bare string literal/)
})

test('r19 HIGH: a gate read through a HELPER fails the census instead of contributing nothing', () => {
  // Codex r19, verbatim: "a helper such as `readGate('RUN_DB_NEW')` contribute no gate".
  const { status, output } = census({
    'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
    'tests/db/delegated.test.ts': [
      "import test from 'node:test'",
      "import { readGate } from '../helpers/gates.ts'",
      "const skip = readGate('RUN_DB_DELEGATED_TESTS') !== '1'",
      "test('delegated', { skip }, () => {})",
      '',
    ].join('\n'),
  })
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /tests\/db\/delegated\.test\.ts:3:\d+ names the gate RUN_DB_DELEGATED_TESTS as a bare string literal/)
})

test('r19 HIGH: binding the whole environment to a name is refused, not silently traversed', () => {
  const { status, output } = census({
    'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
    'tests/db/bound.test.ts': [
      "import test from 'node:test'",
      'const env = process.env',
      "const skip = env.RUN_DB_BOUND_TESTS !== '1'",
      "test('bound', { skip }, () => {})",
      '',
    ].join('\n'),
  })
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /tests\/db\/bound\.test\.ts:2:\d+ binds the whole of process\.env to env/)
})

// ---------------------------------------------------------------------------------------------
// HIGH 3 — recursive glob, non-recursive census.
// ---------------------------------------------------------------------------------------------

test('r19 HIGH: a gated file in a SUBDIRECTORY is censused, because the test command collects it', () => {
  // `test:db` runs `tests/db/**/*.test.ts`; r19's `readdirSync(dir)` listed only direct children, so
  // a gated file one directory down was run by the command and invisible to the guard.
  const { status, output } = census({
    'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
    'tests/db/nested/deep.test.ts': gatedFile('NESTED_TESTS'),
  })
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /RUN_DB_NESTED_TESTS gates tests\/db\/nested\/deep\.test\.ts, but the process "test:db" started for that file had RUN_DB_NESTED_TESTS=null/)
})

test('r19 HIGH: a file the command does NOT collect fails the census, even though it sits in the directory', () => {
  // The other direction of the same defect: a non-recursive glob leaves a file in tests/db that never
  // runs at all. Under r19 nothing compared the two sets, so nothing noticed.
  const { status, output } = census(
    {
      'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
      'tests/db/nested/deep.test.ts': gatedFile('FIXTURE_TESTS'),
    },
    { script: 'RUN_DB_FIXTURE_TESTS=1 REQUIRE_DB_FIXTURE_TESTS=1 node --test "tests/db/*.test.ts"' },
  )
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /"test:db" does not collect tests\/db\/nested\/deep\.test\.ts/)
})

// ---------------------------------------------------------------------------------------------
// HIGH 4 — mentioning a directory was accepted as running it.
// ---------------------------------------------------------------------------------------------

test('r19 HIGH: a script that only MENTIONS the directory collects nothing and fails the census', () => {
  // Codex r19, verbatim: `RUN_DB_RETENTION_TESTS=1 REQUIRE_DB_RETENTION_TESTS=1 true tests/db` passed
  // every r19 check — the gates are set, the directory is named — and exited 0 having collected no
  // tests. That is the green-with-no-suite state the census exists to prevent, reached through it.
  const { status, output } = census(
    { 'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS') },
    { script: 'RUN_DB_FIXTURE_TESTS=1 REQUIRE_DB_FIXTURE_TESTS=1 true tests/db' },
  )
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /collected NO test files at all/)
  assert.match(output, /Naming the directory in the command is not running it/)
})

test('a script that runs a real runner over the WRONG directory collects nothing and fails the census', () => {
  const { status, output } = census(
    {
      'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
      'tests/elsewhere/other.test.ts': "import test from 'node:test'\ntest('other', () => {})\n",
    },
    { script: 'RUN_DB_FIXTURE_TESTS=1 REQUIRE_DB_FIXTURE_TESTS=1 node --test "tests/elsewhere/**/*.test.ts"' },
  )
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /tests\/db\/wired\.test\.ts/)
})

// ---------------------------------------------------------------------------------------------
// The non-vacuity check itself.
// ---------------------------------------------------------------------------------------------

test('r19 HIGH: one file that fails to PARSE fails the census, even while another yields a known gate', () => {
  // r19's only non-vacuity check was `scannedGates === 0`. A single already-known gate kept it
  // nonzero, so a scan that could read nothing else still reported healthy. The check is now per
  // file: every file in the list must have been read AND parsed.
  const { status, output } = census({
    'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
    'tests/db/broken.test.ts': 'const a = (((;\n',
  })
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /tests\/db\/broken\.test\.ts:1:\d+ does not parse/)
  assert.match(output, /reached no verdict about tests\/db\/broken\.test\.ts/)
})

test('the gate verdict comes from the process the runner starts, not from an inherited environment', () => {
  // The verdicts are read out of each collected file's own child process. That would be a new blind
  // spot if a developer with `RUN_DB_UNWIRED_TESTS=1` exported could make an unwired script look
  // wired, so the census strips both halves of every pair from the environment it hands the spawn.
  const { status, output } = census(
    {
      'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS'),
      'tests/db/unwired.test.ts': gatedFile('UNWIRED_TESTS'),
    },
    { env: { RUN_DB_UNWIRED_TESTS: '1', REQUIRE_DB_UNWIRED_TESTS: '1' } },
  )
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /RUN_DB_UNWIRED_TESTS gates tests\/db\/unwired\.test\.ts, but the process "test:db" started for that file had RUN_DB_UNWIRED_TESTS=null/)
})

test('an allowlisted gate is still required to exist, and a stale suppression is reported', () => {
  const { status, output } = census(
    { 'tests/db/wired.test.ts': gatedFile('FIXTURE_TESTS') },
    { allowlist: { RUN_DB_GONE_TESTS: { reason: 'a gate that no longer exists anywhere in the suite' } } },
  )
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /suppresses RUN_DB_GONE_TESTS, but nothing in tests\/db reads it/)
})

test('a gate with no REQUIRE_ tripwire anywhere is refused, because setting the counterpart would change nothing', () => {
  const { status, output } = census(
    {
      'tests/db/wired.test.ts': [
        "import test from 'node:test'",
        "const skip = process.env.RUN_DB_FIXTURE_TESTS !== '1'",
        "test('no tripwire', { skip }, () => {})",
        '',
      ].join('\n'),
    },
  )
  assert.equal(status, 1, `expected a refusal, got:\n${output}`)
  assert.match(output, /nothing in tests\/db\/wired\.test\.ts reads REQUIRE_DB_FIXTURE_TESTS/)
})
