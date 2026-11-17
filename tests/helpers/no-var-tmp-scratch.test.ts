import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

/**
 * Test scratch (throwaway Postgres clusters, temp trees) follows IMS_SCRATCH_ROOT, then TMPDIR (tests/helpers/scratch-root.ts).
 * /var/tmp is on the SSD: write-heavy clusters there wore it out (~84 GB a day). This guard fails when a `/var/tmp` literal
 * appears in a file a test can reach to create scratch, unless the file is listed below with the reason it may.
 *
 * Scanned: tests/ (everything), scripts/*.ts (rehearsals, gate scripts) and lib/first-load/apply/*.ts.
 * Mentions in comments are ignored; only code literals count.
 */
const REPO = process.cwd()

/** file -> why a /var/tmp literal is allowed there. */
const ALLOWED: Record<string, string> = {
  // Operator defaults: real runs on a server whose reports must survive a reboot. Tests always pass their own roots.
  'scripts/rehearse-first-install.ts': 'operator default: --root (cluster parent) and --report-dir of `npm run rehearse:first-install`',
  'scripts/rehearse-woo-import.ts': 'operator default: --root and --report-dir of the Woo import rehearsal',
  'lib/first-load/apply/cli.ts': 'operator default: --root of `first-load:apply --rehearse` (operator runbook, docs/first-load-apply.md)',
  'scripts/container-smoke.sh': 'reads the published reconciliation-pack report from the operator default dir inside the smoke container',
  'tests/first-load/po-currency-from-supplier.test.ts': 'the owner\'s real export files, left there by hand; read only, skipped when absent',
  // Inert strings: path text under test, nothing is created there.
  'tests/helpers/readiness-gate-fixtures.ts': 'a restore-point path inside a fixture report; never created',
  'tests/ops/readiness-gate.test.ts': 'a checkout-path string compared by the gate; never created',
  'tests/ops/readiness-gate-first-load.test.ts': 'a directory that must not exist',
  'tests/first-load/apply-cli.test.ts': 'argv strings for the argument parser and fake-dependency arms; nothing is created',
  'tests/scripts/rehearse-first-install.test.ts': 'argv strings for parseArgs; nothing is created',
  'tests/reconciliation-pack/cli.test.ts': 'argv strings and a repoRoot value for fake ports; nothing is created',
  'tests/reconciliation-pack/cli-qoblex.test.ts': 'argv strings and a repoRoot value for fake ports; nothing is created',
  'tests/reconciliation-pack/cli-po-transit.test.ts': 'a repoRoot value for fake ports',
  'tests/reconciliation-pack/cli-xero-rate.test.ts': 'a repoRoot value for fake ports',
  'tests/reconciliation-pack/cli-vendor.test.ts': 'a repoRoot value for fake ports',
  'tests/reconciliation-pack/cli-default-ports.test.ts': 'a repoRoot / cwd value for fake ports',
  'tests/reconciliation-pack/default-ports.test.ts': 'a cwd value for fake ports',
  'tests/reconciliation-pack/settling.test.ts': 'a repoRoot value for fake ports',
  'tests/reconciliation-pack/sku-exclusions.test.ts': 'a checkout-root argument to the loaders (they only compare it); files are made under the scratch dir',
  'tests/settings/crontab-reconcile-serialization.test.ts': 'a systemd PrivateTmp description string',
  'tests/helpers/scratch-root.ts': 'the forbidden-path constant scratchRoot() uses to refuse /var/tmp',
  'tests/helpers/scratch-root.test.ts': 'asserts scratchRoot() is never /var/tmp',
  'tests/helpers/no-var-tmp-scratch.test.ts': 'this guard',
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|mts|cts|js|mjs|cjs|sh)$/.test(name)) yield full
  }
}

function scanned(): string[] {
  const files = [...walk(path.join(REPO, 'tests'))]
  for (const dir of ['scripts', 'lib/first-load/apply']) {
    for (const name of readdirSync(path.join(REPO, dir))) if (/\.(ts|mts|js|mjs|sh)$/.test(name)) files.push(path.join(REPO, dir, name))
  }
  return files.map((f) => path.relative(REPO, f))
}

/** Lines that carry a /var/tmp literal outside a comment. */
function offending(file: string): number[] {
  const hits: number[] = []
  readFileSync(path.join(REPO, file), 'utf8').split('\n').forEach((line, i) => {
    if (!line.includes('/var/tmp')) return
    const code = line.replace(/(^|\s)\/\/.*$/, '$1').replace(/^\s*(\*|\/\*).*$/, '')
    if (code.includes('/var/tmp')) hits.push(i + 1)
  })
  return hits
}

test('no /var/tmp literal in test-reachable scratch code outside the documented allowlist', () => {
  const files = scanned()
  assert.ok(files.length > 500, `precondition: scanned the tree (${files.length} files)`)
  const found = files.filter((f) => offending(f).length > 0).filter((f) => !(f in ALLOWED))
  assert.deepEqual(found.map((f) => `${f}:${offending(f).join(',')}`), [], 'scratch follows scratchRoot() (IMS_SCRATCH_ROOT, then TMPDIR); never /var/tmp')
})

test('every allowlist entry still needs its exception (a stale entry hides a future regression)', () => {
  const stale = Object.keys(ALLOWED).filter((f) => f !== 'tests/helpers/no-var-tmp-scratch.test.ts' && offending(f).length === 0)
  assert.deepEqual(stale, [])
})

test('scratchRoot() mentions /var/tmp only to refuse it', () => {
  const lines = offending('tests/helpers/scratch-root.ts')
  const source = readFileSync(path.join(REPO, 'tests/helpers/scratch-root.ts'), 'utf8').split('\n')
  assert.deepEqual(lines.map((n) => source[n - 1]!.trim()), ["const FORBIDDEN = '/var/tmp'"])
})
